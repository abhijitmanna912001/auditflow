"""Unit tests for the Decision Agent that do not call the real API.

The Anthropic client is injected as a fake, so these run in CI without
network access or an ANTHROPIC_API_KEY. The action decision is deterministic
(computed in code, not by the model - see decision_agent.py's module
docstring), so it gets direct coverage here rather than only end-to-end.
"""

import json

import pytest

from decision_agent import (
    run_decision_agent,
    _confidence_of_highest_severity_finding,
    _decide_action,
)


class _FakeTextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, reason):
        self.content = [_FakeTextBlock(json.dumps({"transactions": [{"reason": reason}]}))]


class _FakeMessages:
    def __init__(self, reason):
        self._reason = reason
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeResponse(self._reason)


class _FakeClient:
    def __init__(self, reason="stubbed reason"):
        self.messages = _FakeMessages(reason)


def test_decide_action_empty_findings_auto_clears():
    assert _decide_action([]) == "auto_clear"


def test_decide_action_any_findings_at_all_means_human_review():
    # Regression test for the corrected rule: a single, very-high-confidence
    # finding (the CASE_04 scenario - an obvious amount mismatch the Anomaly
    # Agent rated 0.97) must NOT auto-clear just because confidence is high.
    high_confidence_finding = [
        {
            "type": "amount_mismatch",
            "documents": ["PO-1004", "INV-1004"],
            "severity": "high",
            "confidence": 0.97,
            "explanation": "Invoice total exceeds PO total.",
        }
    ]
    assert _decide_action(high_confidence_finding) == "human_review"

    low_confidence_finding = [
        {
            "type": "date_inconsistency",
            "documents": ["INV-1", "PO-1"],
            "severity": "low",
            "confidence": 0.1,
            "explanation": "Dates are slightly inconsistent.",
        }
    ]
    assert _decide_action(low_confidence_finding) == "human_review"


def test_confidence_of_highest_severity_finding_no_findings():
    assert _confidence_of_highest_severity_finding([]) == 1.0


def test_confidence_of_highest_severity_finding_picks_highest_severity():
    findings = [
        {"severity": "low", "confidence": 0.99},
        {"severity": "high", "confidence": 0.6},
        {"severity": "medium", "confidence": 0.85},
    ]
    assert _confidence_of_highest_severity_finding(findings) == 0.6


def test_confidence_of_highest_severity_finding_ties_take_the_minimum():
    # two findings tied at the highest severity - conservative tie-break
    # picks the lower confidence (pushes toward human_review, not auto_clear)
    findings = [
        {"severity": "high", "confidence": 0.97},
        {"severity": "high", "confidence": 0.6},
    ]
    assert _confidence_of_highest_severity_finding(findings) == 0.6


def test_run_decision_agent_clean_transaction_auto_clears():
    anomaly_transaction = {
        "transaction_id": "TXN_01",
        "case_id": "CASE_01",
        "findings": [],
    }
    client = _FakeClient()

    result = run_decision_agent(anomaly_transaction, client=client)

    assert result["action"] == "auto_clear"
    assert result["confidence"] == 1.0
    assert result["findings"] == []
    assert result["thresholds_used"] == {"auto_clear": 0.95, "human_review": 0.80}
    assert result["transaction_id"] == "TXN_01"
    assert result["case_id"] == "CASE_01"


def test_run_decision_agent_carries_findings_forward_without_confidence():
    anomaly_transaction = {
        "transaction_id": "TXN_04",
        "case_id": "CASE_04",
        "findings": [
            {
                "type": "vendor_mismatch",
                "documents": ["INV-104", "PO-104"],
                "severity": "medium",
                "confidence": 0.81,
                "explanation": "Vendor name on invoice differs from PO vendor field",
            }
        ],
    }
    client = _FakeClient()

    result = run_decision_agent(anomaly_transaction, client=client)

    assert result["action"] == "human_review"
    assert result["confidence"] == 0.81
    # confidence is dropped from the carried-forward finding
    assert result["findings"] == [
        {
            "type": "vendor_mismatch",
            "documents": ["INV-104", "PO-104"],
            "severity": "medium",
            "explanation": "Vendor name on invoice differs from PO vendor field",
        }
    ]

    sent_message = client.messages.last_kwargs["messages"][0]["content"]
    assert "vendor_mismatch" in sent_message
    assert "human_review" in sent_message


def test_run_decision_agent_high_confidence_finding_does_not_auto_clear():
    # End-to-end regression test for the CASE_04 bug: a single high-severity
    # finding with confidence above the old 0.95 auto_clear threshold must
    # still route to human_review under the corrected rule.
    anomaly_transaction = {
        "transaction_id": "TXN_04",
        "case_id": "CASE_04",
        "findings": [
            {
                "type": "amount_mismatch",
                "documents": ["PO-1004", "INV-1004", "REC-1004", "BNK-1004", "LED-1004"],
                "severity": "high",
                "confidence": 0.97,
                "explanation": "Invoice, bank debit, and ledger exceed the approved PO amount.",
            }
        ],
    }
    client = _FakeClient()

    result = run_decision_agent(anomaly_transaction, client=client)

    assert result["action"] == "human_review"
    assert result["confidence"] == 0.97  # still reported, just not decisive


def test_run_decision_agent_ignores_model_reason_wrapper_and_uses_reason_text():
    anomaly_transaction = {"transaction_id": "TXN_09", "case_id": "CASE_09", "findings": []}
    client = _FakeClient(reason="Transaction was clean; auto-cleared per threshold.")

    result = run_decision_agent(anomaly_transaction, client=client)

    assert result["reason"] == "Transaction was clean; auto-cleared per threshold."


def test_run_decision_agent_raises_when_model_returns_wrong_transaction_count():
    anomaly_transaction = {"transaction_id": "TXN_01", "case_id": "CASE_01", "findings": []}

    class _ZeroTransactionsResponse:
        def __init__(self):
            self.content = [_FakeTextBlock(json.dumps({"transactions": []}))]

    class _ZeroTransactionsMessages:
        def create(self, **kwargs):
            return _ZeroTransactionsResponse()

    class _ZeroTransactionsClient:
        def __init__(self):
            self.messages = _ZeroTransactionsMessages()

    with pytest.raises(ValueError):
        run_decision_agent(anomaly_transaction, client=_ZeroTransactionsClient())
