"""Tests for the API access-control layer in orchestration/api.py.
No model API calls: the pipeline functions are monkeypatched."""

import hashlib
import hmac
import json
import logging
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from orchestration import api  # noqa: E402

PEPPER = "test-pepper-not-a-secret"
ALICE_CODE = "AF-alice-test-code"
BOB_CODE = "AF-bob-test-code"
RESULT = {"ok": True}


def _hash(code: str) -> str:
    return hmac.new(PEPPER.encode(), code.encode(), hashlib.sha256).hexdigest()


def _config(**alice_overrides) -> str:
    alice = {"hash": _hash(ALICE_CODE), "daily_runs": 2, "max_files": 2,
             "max_file_mb": 1, "resolver": False, **alice_overrides}
    bob = {"hash": _hash(BOB_CODE), "daily_runs": 5, "max_files": 10,
           "max_file_mb": 20, "resolver": True}
    return json.dumps({"alice": alice, "bob": bob})


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "_FEEDBACK_FILE", tmp_path / "feedback.json")
    monkeypatch.setattr(api, "run_full_pipeline", lambda folder: RESULT)
    monkeypatch.setattr(api, "run_full_pipeline_from_documents", lambda c, f: RESULT)
    monkeypatch.setattr(api, "run_full_pipeline_from_documents_with_resolver", lambda c, f: RESULT)
    for name in ("AUDITFLOW_ACCESS_CODES", "AUDITFLOW_CODE_PEPPER",
                 "AUDITFLOW_SAMPLE_DAILY_CAP", "AUDITFLOW_SAMPLE_REQUIRE_CODE"):
        monkeypatch.delenv(name, raising=False)
    yield
    for name in ("AUDITFLOW_ACCESS_CODES", "AUDITFLOW_CODE_PEPPER",
                 "AUDITFLOW_SAMPLE_DAILY_CAP", "AUDITFLOW_SAMPLE_REQUIRE_CODE"):
        monkeypatch.delenv(name, raising=False)
    api._init_access_control()  # back to OFF for other tests


@pytest.fixture
def enable(monkeypatch):
    def _enable(config=None, **env):
        monkeypatch.setenv("AUDITFLOW_ACCESS_CODES", config or _config())
        monkeypatch.setenv("AUDITFLOW_CODE_PEPPER", PEPPER)
        for k, v in env.items():
            monkeypatch.setenv(k, str(v))
        api._init_access_control()
        return TestClient(api.app)
    return _enable


def _upload(client, code=None, n=1, size=10, **params):
    headers = {"X-Access-Code": code} if code else {}
    files = [("files", (f"f{i}.pdf", b"x" * size, "application/pdf")) for i in range(n)]
    return client.post("/run-case-upload", params={"case_id": "C", **params},
                       files=files, headers=headers)


def _feedback(client, code=None):
    headers = {"X-Access-Code": code} if code else {}
    return client.post("/feedback", headers=headers, json={
        "case_id": "C", "document": "d", "finding": "f", "agent_action": "a",
        "decision": "confirmed"})


def _sample(client, code=None):
    headers = {"X-Access-Code": code} if code else {}
    return client.post("/run-case", json={"case_id": "CASE_09"}, headers=headers)


def test_off_when_env_unset_all_endpoints_open():
    api._init_access_control()
    client = TestClient(api.app)
    assert _upload(client).status_code == 200
    assert _feedback(client).status_code == 201
    assert client.get("/feedback/history").status_code == 200
    assert _sample(client).status_code == 200
    assert _upload(client, use_resolver="true").status_code == 200


def test_on_requires_code_for_upload_feedback_history(enable):
    client = enable()
    for code in (None, "AF-wrong"):
        assert _upload(client, code).status_code == 401
        assert _feedback(client, code).status_code == 401
        headers = {"X-Access-Code": code} if code else {}
        assert client.get("/feedback/history", headers=headers).status_code == 401
    assert "detail" in _upload(client).json()


def test_valid_code_passes(enable):
    client = enable()
    assert _upload(client, ALICE_CODE).json() == RESULT
    assert _feedback(client, ALICE_CODE).status_code == 201
    assert len(client.get("/feedback/history", headers={"X-Access-Code": BOB_CODE}).json()) == 1


def test_daily_limit_per_client(enable):
    client = enable()
    assert _upload(client, ALICE_CODE).status_code == 200
    assert _upload(client, ALICE_CODE).status_code == 200
    assert _upload(client, ALICE_CODE).status_code == 429
    assert _upload(client, BOB_CODE).status_code == 200  # separate counter


def test_daily_counter_resets_on_new_utc_day(enable, monkeypatch):
    client = enable()
    monkeypatch.setattr(api, "_utc_day", lambda: "2030-01-01")
    _upload(client, ALICE_CODE)
    _upload(client, ALICE_CODE)
    assert _upload(client, ALICE_CODE).status_code == 429
    monkeypatch.setattr(api, "_utc_day", lambda: "2030-01-02")
    assert _upload(client, ALICE_CODE).status_code == 200


def test_rejected_requests_do_not_use_a_run(enable):
    client = enable()
    assert _upload(client, ALICE_CODE, n=3).status_code == 400
    assert _upload(client, ALICE_CODE).status_code == 200
    assert _upload(client, ALICE_CODE).status_code == 200


def test_resolver_forbidden_unless_allowed(enable):
    client = enable()
    resp = _upload(client, ALICE_CODE, use_resolver="true")
    assert resp.status_code == 403 and "resolver" in resp.json()["detail"]
    assert _upload(client, BOB_CODE, use_resolver="true").status_code == 200


def test_max_files(enable):
    client = enable()
    resp = _upload(client, ALICE_CODE, n=3)
    assert resp.status_code == 400 and "max 2" in resp.json()["detail"]
    assert _upload(client, BOB_CODE, n=3).status_code == 200


def test_max_file_mb(enable):
    client = enable()
    resp = _upload(client, ALICE_CODE, size=1024 * 1024 + 1)
    assert resp.status_code == 413 and "1 MB" in resp.json()["detail"]


def test_sample_global_cap(enable):
    client = enable(AUDITFLOW_SAMPLE_DAILY_CAP=2)
    assert _sample(client).status_code == 200
    assert _sample(client).status_code == 200
    assert _sample(client).status_code == 429


def test_sample_requires_code_switch(enable):
    client = enable(AUDITFLOW_SAMPLE_REQUIRE_CODE="true")
    assert _sample(client).status_code == 401
    assert _sample(client, "AF-wrong").status_code == 401
    assert _sample(client, ALICE_CODE).status_code == 200


def test_invalid_json_fails_at_startup(monkeypatch):
    monkeypatch.setenv("AUDITFLOW_ACCESS_CODES", "{not json")
    monkeypatch.setenv("AUDITFLOW_CODE_PEPPER", PEPPER)
    with pytest.raises(RuntimeError, match="not valid JSON"):
        api._init_access_control()


def test_missing_pepper_fails_at_startup(monkeypatch):
    monkeypatch.setenv("AUDITFLOW_ACCESS_CODES", _config())
    with pytest.raises(RuntimeError, match="AUDITFLOW_CODE_PEPPER"):
        api._init_access_control()


def test_cors_allows_access_code_header(enable):
    client = enable()
    resp = client.options("/run-case-upload", headers={
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-access-code",
    })
    assert resp.status_code == 200
    assert "x-access-code" in resp.headers["access-control-allow-headers"].lower()


def test_codes_and_hashes_never_logged(enable, caplog):
    caplog.set_level(logging.DEBUG)
    client = enable()
    _upload(client, ALICE_CODE)
    _upload(client, "AF-wrong-code")
    _feedback(client, ALICE_CODE)
    client.get("/feedback/history", headers={"X-Access-Code": BOB_CODE})
    text = caplog.text
    assert "Access control: ON" in text and "meter client=alice" in text
    for secret in (ALICE_CODE, BOB_CODE, "AF-wrong-code", PEPPER, _hash(ALICE_CODE), "f0.pdf"):
        assert secret not in text
