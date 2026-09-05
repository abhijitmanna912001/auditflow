"""Unit tests for the Workpaper Agent that do not call the real API.

The Anthropic client is injected as a fake, so these run in CI without
network access or an ANTHROPIC_API_KEY.
"""

import json

import pytest

from workpaper_agent import run_workpaper_agent, _FINDING_LABEL_REQUEST_SCHEMA


class _FakeTextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, rows):
        self.content = [_FakeTextBlock(json.dumps({"rows": rows}))]


class _FakeMessages:
    def __init__(self, rows):
        self._rows = rows
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeResponse(self._rows)


class _FakeClient:
    def __init__(self, rows=()):
        self.messages = _FakeMessages(list(rows))


class _ExplodingMessages:
    """Raises if .create() is ever called - proves no API call was made."""

    def create(self, **kwargs):
        raise AssertionError("no API call should be made when every row is clean")


class _ExplodingClient:
    def __init__(self):
        self.messages = _ExplodingMessages()


_CLEAN_DECISION = {
    "transaction_id": "TXN_01",
    "case_id": "CASE_01",
    "action": "auto_clear",
    "confidence": 1.0,
    "reason": "No findings.",
    "thresholds_used": {"auto_clear": 0.95, "human_review": 0.80},
    "findings": [],
}

_CLEAN_EVIDENCE = {
    "transaction_id": "TXN_01",
    "case_id": "CASE_01",
    "documents": ["INV-1001", "PO-1001", "REC-1001", "BNK-1001", "LED-1001"],
    "missing_evidence": [],
    "evidence_confidence": 0.95,
    "notes": "Clean.",
}

_FINDING_DECISION = {
    "transaction_id": "TXN_04",
    "case_id": "CASE_04",
    "action": "human_review",
    "confidence": 0.81,
    "reason": "Vendor mismatch detected.",
    "thresholds_used": {"auto_clear": 0.95, "human_review": 0.80},
    "findings": [
        {
            "type": "vendor_mismatch",
            "documents": ["INV-104", "PO-104"],
            "severity": "medium",
            "explanation": "Vendor name on invoice differs from PO vendor field",
        }
    ],
}


def test_run_workpaper_agent_clean_case_makes_no_api_call():
    result = run_workpaper_agent(
        [_CLEAN_DECISION], [_CLEAN_EVIDENCE], client=_ExplodingClient()
    )

    assert result["case_id"] == "CASE_01"
    assert result["rows"] == [
        {
            "document": "INV-1001",
            "finding": "Clean",
            "evidence": ["INV-1001", "PO-1001", "REC-1001", "BNK-1001", "LED-1001"],
            "confidence": 1.0,
            "action": "auto_clear",
        }
    ]
    assert result["summary"] == {
        "items_reviewed": 1,
        "auto_cleared": 1,
        "human_review": 0,
        "critical": 0,
        "assumed_minutes_per_item": 3,
        "estimated_minutes_saved": 3,
    }


def test_run_workpaper_agent_clean_case_without_evidence_transactions():
    # no evidence_transactions supplied at all - document/evidence fall back
    # to None/[] rather than crashing
    result = run_workpaper_agent([_CLEAN_DECISION], client=_ExplodingClient())

    assert result["rows"][0]["document"] is None
    assert result["rows"][0]["evidence"] == []


def test_run_workpaper_agent_finding_row_uses_finding_documents_and_model_label():
    client = _FakeClient(rows=[{"transaction_id": "TXN_04", "finding_summary": "Vendor mismatch"}])

    result = run_workpaper_agent([_FINDING_DECISION], [], client=client)

    row = result["rows"][0]
    assert row["document"] == "INV-104"
    assert row["evidence"] == ["INV-104", "PO-104"]
    assert row["finding"] == "Vendor mismatch"
    assert row["confidence"] == 0.81
    assert row["action"] == "human_review"

    sent_message = client.messages.last_kwargs["messages"][0]["content"]
    assert "vendor_mismatch" in sent_message
    assert (
        client.messages.last_kwargs["output_config"]["format"]["schema"]
        == _FINDING_LABEL_REQUEST_SCHEMA
    )


def test_run_workpaper_agent_summary_counts_across_multiple_transactions():
    # A hypothetical multi-transaction case (this benchmark never produces
    # one, but the aggregation logic should still be correct in general):
    # both transactions share one case_id, with different transaction_ids.
    clean_txn = dict(_CLEAN_DECISION, transaction_id="TXN_99a", case_id="CASE_99")
    clean_evidence = dict(_CLEAN_EVIDENCE, transaction_id="TXN_99a", case_id="CASE_99")
    finding_txn = dict(_FINDING_DECISION, transaction_id="TXN_99b", case_id="CASE_99")
    finding_txn["findings"] = [dict(_FINDING_DECISION["findings"][0], severity="high")]
    client = _FakeClient(rows=[{"transaction_id": "TXN_99b", "finding_summary": "Vendor mismatch"}])

    result = run_workpaper_agent([clean_txn, finding_txn], [clean_evidence], client=client)

    assert result["summary"] == {
        "items_reviewed": 2,
        "auto_cleared": 1,
        "human_review": 1,
        "critical": 1,
        "assumed_minutes_per_item": 3,
        "estimated_minutes_saved": 3,
    }


def test_run_workpaper_agent_respects_custom_assumed_minutes_per_item():
    result = run_workpaper_agent(
        [_CLEAN_DECISION], [_CLEAN_EVIDENCE], assumed_minutes_per_item=5, client=_ExplodingClient()
    )

    assert result["summary"]["assumed_minutes_per_item"] == 5
    assert result["summary"]["estimated_minutes_saved"] == 5


def test_run_workpaper_agent_raises_on_empty_input():
    with pytest.raises(ValueError):
        run_workpaper_agent([], client=_ExplodingClient())


def test_run_workpaper_agent_raises_on_mixed_case_ids():
    other_case = dict(_CLEAN_DECISION, transaction_id="TXN_02", case_id="CASE_02")
    with pytest.raises(ValueError):
        run_workpaper_agent([_CLEAN_DECISION, other_case], client=_ExplodingClient())
