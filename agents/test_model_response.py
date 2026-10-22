"""Tests for model_response.parse_json_response and for how each agent and
the API treat an unusable model response. No model API calls: fakes only."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from anomaly_agent import run_anomaly_agent  # noqa: E402
from decision_agent import run_decision_agent  # noqa: E402
from evidence_agent import run_evidence_agent  # noqa: E402
from intake_agent import _call_intake  # noqa: E402
from model_response import (  # noqa: E402
    ModelResponseError,
    ModelResponseFormatError,
    parse_json_response,
)
from orchestration import api  # noqa: E402
from workpaper_agent import _generate_finding_labels  # noqa: E402

SECRET_TEXT = "ACME Ltd invoice INV-777 total 1,234.00"


def _text(text):
    return SimpleNamespace(type="text", text=text)


def _thinking():
    return SimpleNamespace(type="thinking", thinking="", signature="sig")


def _response(blocks, stop_reason="end_turn"):
    return SimpleNamespace(content=blocks, stop_reason=stop_reason)


class _Client:
    def __init__(self, response):
        self.messages = SimpleNamespace(create=lambda **kwargs: response)


GOOD = _response([_text(json.dumps({"ok": 1}))])
REFUSAL = _response([], stop_reason="refusal")
NO_TEXT = _response([_thinking()])
CUT_OFF_BEFORE_TEXT = _response([_thinking()], stop_reason="max_tokens")
TRUNCATED = _response([_text('{"documents": [{"doc_id": "' + SECRET_TEXT)], stop_reason="max_tokens")
BAD_JSON = _response([_text("not json " + SECRET_TEXT)])


def test_good_response_is_parsed_and_thinking_block_is_skipped():
    assert parse_json_response(GOOD, "intake") == {"ok": 1}
    mixed = _response([_thinking(), _text('{"a": 2}')])
    assert parse_json_response(mixed, "intake") == {"a": 2}


def test_fake_response_without_stop_reason_still_works():
    plain = SimpleNamespace(content=[_text('{"a": 3}')])
    assert parse_json_response(plain, "intake") == {"a": 3}


@pytest.mark.parametrize(
    "response, cause",
    [
        (REFUSAL, "refusal"),
        (NO_TEXT, "no_text"),
        (_response([]), "no_text"),
        (CUT_OFF_BEFORE_TEXT, "truncated"),
        (TRUNCATED, "truncated"),
        (BAD_JSON, "parse"),
    ],
)
def test_each_cause_raises_model_response_error(response, cause):
    with pytest.raises(ModelResponseError) as info:
        parse_json_response(response, "anomaly", "claude-x")
    err = info.value
    assert err.cause == cause
    assert err.agent == "anomaly"
    assert err.model == "claude-x"
    assert "anomaly" in str(err) and cause in str(err)


def test_message_never_contains_model_or_document_text():
    for response in (TRUNCATED, BAD_JSON):
        with pytest.raises(ModelResponseError) as info:
            parse_json_response(response, "intake", "claude-x")
        assert "ACME" not in str(info.value) and "INV-777" not in str(info.value)
        assert info.value.__cause__ is None  # JSONDecodeError quotes the text


def test_no_text_is_not_a_value_error_but_truncated_and_parse_are():
    # Mirrors what the old code raised, so the API status codes do not change.
    for response in (REFUSAL, NO_TEXT):
        with pytest.raises(ModelResponseError) as info:
            parse_json_response(response, "intake")
        assert not isinstance(info.value, ValueError)
    for response in (TRUNCATED, BAD_JSON):
        with pytest.raises(ModelResponseError) as info:
            parse_json_response(response, "intake")
        assert isinstance(info.value, ModelResponseFormatError)
        assert isinstance(info.value, ValueError)


# ---- every agent uses it -------------------------------------------------

_INTAKE_DOCS = [{"doc_id": "INV-1", "case_id": "CASE_01", "type": "invoice"}]
_EVIDENCE_TXN = {"case_id": "CASE_01", "transaction_id": "TXN_01", "documents": ["INV-1"]}
_ANOMALY_TXN = {"case_id": "CASE_01", "transaction_id": "TXN_01", "findings": []}

AGENT_CALLS = {
    "intake": lambda c: _call_intake("hello", client=c),
    "evidence": lambda c: run_evidence_agent(_INTAKE_DOCS, client=c),
    "anomaly": lambda c: run_anomaly_agent(_EVIDENCE_TXN, _INTAKE_DOCS, client=c),
    "decision": lambda c: run_decision_agent(_ANOMALY_TXN, client=c),
    "workpaper": lambda c: _generate_finding_labels([{"transaction_id": "TXN_01", "findings": []}], client=c),
}


@pytest.mark.parametrize("agent", sorted(AGENT_CALLS))
@pytest.mark.parametrize(
    "response, cause",
    [(REFUSAL, "refusal"), (NO_TEXT, "no_text"), (TRUNCATED, "truncated"), (BAD_JSON, "parse")],
)
def test_every_agent_raises_model_response_error(agent, response, cause):
    with pytest.raises(ModelResponseError) as info:
        AGENT_CALLS[agent](_Client(response))
    assert info.value.agent == agent and info.value.cause == cause


# ---- API handling is unchanged -------------------------------------------


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(api, "_access_enabled", False)
    return TestClient(api.app)


def _raiser(exc):
    def run(*args, **kwargs):
        raise exc
    return run


def _post_upload(client):
    files = [("files", ("a.pdf", b"x", "application/pdf"))]
    return client.post("/run-case-upload", params={"case_id": "C"}, files=files)


def test_run_case_returns_500_with_the_clear_message(client, monkeypatch):
    for cause, exc in (
        ("no_text", ModelResponseError("anomaly", "no_text")),
        ("truncated", ModelResponseFormatError("anomaly", "truncated")),
    ):
        monkeypatch.setattr(api, "run_full_pipeline", _raiser(exc))
        response = client.post("/run-case", json={"case_id": "CASE_01"})
        assert response.status_code == 500
        assert response.json()["detail"] == str(exc) and cause in response.json()["detail"]


def test_upload_keeps_todays_status_codes(client, monkeypatch):
    # StopIteration used to be 500; a JSONDecodeError (a ValueError) used to be 400.
    monkeypatch.setattr(
        api, "run_full_pipeline_from_documents", _raiser(ModelResponseError("intake", "no_text"))
    )
    assert _post_upload(client).status_code == 500
    monkeypatch.setattr(
        api, "run_full_pipeline_from_documents", _raiser(ModelResponseFormatError("intake", "parse"))
    )
    assert _post_upload(client).status_code == 400
