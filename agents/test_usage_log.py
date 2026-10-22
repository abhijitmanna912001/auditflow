"""Tests for usage_log.create_message and the usage log line. No model API
calls: fakes only."""

import logging
from types import SimpleNamespace

import pytest

from anomaly_agent import run_anomaly_agent
from decision_agent import run_decision_agent
from evidence_agent import run_evidence_agent
from intake_agent import _call_intake
from model_config import Settings, use_config
from model_response import ModelResponseError
from usage_log import (
    UsageRecord,
    collect_usage,
    create_message,
    format_line,
    make_record,
    pre_call_guard,
)
from workpaper_agent import _generate_finding_labels

FMT = {"format": {"type": "json_schema", "schema": {"type": "object"}}}


def _usage(**counts):
    base = dict(input_tokens=1200, output_tokens=340, cache_read_input_tokens=7, cache_creation_input_tokens=9)
    return SimpleNamespace(**{**base, **counts})


class _Client:
    def __init__(self, usage=None, content=()):
        self.calls = []
        self._response = SimpleNamespace(content=list(content), stop_reason="end_turn", usage=usage)
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


@pytest.fixture
def lines(caplog):
    caplog.set_level(logging.INFO, logger="auditflow.usage")

    def get():
        return [r.getMessage() for r in caplog.records if r.name == "auditflow.usage"]

    return get


def test_one_line_per_call_with_exactly_the_counts(lines):
    client = _Client(_usage())
    response = create_message(client, "anomaly", FMT, system="s", messages=[{"role": "user", "content": "m"}])
    assert response is client._response
    (line,) = lines()
    parts = dict(p.split("=") for p in line.split()[1:])
    assert line.startswith("usage ")
    assert list(parts) == [
        "agent", "model", "input_tokens", "output_tokens",
        "cache_read_tokens", "cache_write_tokens", "latency_ms",
    ]
    assert parts["agent"] == "anomaly" and parts["model"] == "claude-opus-5"
    assert (parts["input_tokens"], parts["output_tokens"]) == ("1200", "340")
    assert (parts["cache_read_tokens"], parts["cache_write_tokens"]) == ("7", "9")
    assert parts["latency_ms"].isdigit()


def test_request_is_built_from_model_config_and_other_kwargs_pass_through():
    client = _Client(_usage())
    create_message(client, "intake", FMT, system="SYS", messages=[{"role": "user", "content": "hi"}])
    (sent,) = client.calls
    assert sent == {
        "model": "claude-sonnet-5", "max_tokens": 16000, "output_config": FMT,
        "system": "SYS", "messages": [{"role": "user", "content": "hi"}],
    }
    with use_config({"intake": Settings("claude-haiku-5-5", 16000, "medium")}):
        create_message(client, "intake", FMT, system="SYS", messages=[])
    assert client.calls[1]["model"] == "claude-haiku-5-5"
    assert client.calls[1]["output_config"]["effort"] == "medium"


def test_missing_usage_writes_no_line_and_does_not_fail(lines):
    create_message(_Client(usage=None), "intake", FMT, system="s", messages=[])
    assert lines() == []


def test_hostile_values_cannot_reach_the_line(lines):
    secret_usage = SimpleNamespace(
        input_tokens="Invoice from ACME Ltd 1,234.00", output_tokens=True,
        cache_read_input_tokens=-5, cache_creation_input_tokens=None,
    )
    record = make_record("INV-777.pdf", "ACME Ltd claude-sonnet-5", secret_usage, "12ms")
    line = format_line(record)
    for text in ("ACME", "Invoice", "INV-777", ".pdf", "1,234"):
        assert text not in line
    assert record == UsageRecord("unknown", "unknown", 0, 0, 0, 0, 0)


def test_no_document_text_or_filename_appears_through_a_real_agent_call(lines):
    secret_doc = "TAX INVOICE ACME Ltd Source file: secret-client-invoice.pdf amount 98,765.43"
    client = _Client(_usage())  # no text block -> the agent raises after the call
    with pytest.raises(ModelResponseError):
        _call_intake(secret_doc, client=client)
    (line,) = lines()
    assert "ACME" not in line and "secret-client" not in line and "98,765" not in line
    assert "agent=intake" in line


_DOCS = [{"doc_id": "INV-1", "case_id": "CASE_01", "type": "invoice"}]
_EVIDENCE = {"case_id": "CASE_01", "transaction_id": "TXN_01", "documents": ["INV-1"]}
_ANOMALY = {"case_id": "CASE_01", "transaction_id": "TXN_01", "findings": []}
CALLS = {
    "intake": lambda c: _call_intake("x", client=c),
    "evidence": lambda c: run_evidence_agent(_DOCS, client=c),
    "anomaly": lambda c: run_anomaly_agent(_EVIDENCE, _DOCS, client=c),
    "decision": lambda c: run_decision_agent(_ANOMALY, client=c),
    "workpaper": lambda c: _generate_finding_labels([{"transaction_id": "T", "findings": []}], client=c),
}


@pytest.mark.parametrize("agent", sorted(CALLS))
def test_each_of_the_five_agents_logs_exactly_one_line(agent, lines):
    with pytest.raises(ModelResponseError):
        CALLS[agent](_Client(_usage()))
    (line,) = lines()
    assert f"agent={agent} " in line


def test_collector_gathers_the_same_counts_and_is_off_by_default(lines):
    client = _Client(_usage())
    create_message(client, "decision", FMT, system="s", messages=[])
    with collect_usage() as records:
        create_message(client, "decision", FMT, system="s", messages=[])
        create_message(client, "intake", FMT, system="s", messages=[])
    create_message(client, "decision", FMT, system="s", messages=[])
    assert [r.agent for r in records] == ["decision", "intake"]
    assert records[0].input_tokens == 1200 and records[0].model == "claude-sonnet-5"
    assert len(lines()) == 4


def test_guard_runs_before_the_call_and_can_stop_it():
    client = _Client(_usage())
    seen = []

    def guard(agent, params, kwargs):
        seen.append((agent, params["model"], kwargs["system"]))
        raise RuntimeError("stop")

    with pre_call_guard(guard):
        with pytest.raises(RuntimeError):
            create_message(client, "anomaly", FMT, system="SYS", messages=[])
    assert client.calls == [] and seen == [("anomaly", "claude-opus-5", "SYS")]
    create_message(client, "anomaly", FMT, system="SYS", messages=[])  # guard is gone
    assert len(client.calls) == 1
