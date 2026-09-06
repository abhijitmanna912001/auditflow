"""Unit tests for the Anomaly Agent that do not call the real API.

The Anthropic client is injected as a fake, so these run in CI without
network access or an ANTHROPIC_API_KEY.
"""

import json

import pytest

from anomaly_agent import run_anomaly_agent, OUTPUT_SCHEMA, SYSTEM_PROMPT


class _FakeTextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, transactions):
        self.content = [_FakeTextBlock(json.dumps({"transactions": transactions}))]


class _FakeMessages:
    def __init__(self, transactions):
        self._transactions = transactions
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeResponse(self._transactions)


class _FakeClient:
    def __init__(self, transactions):
        self.messages = _FakeMessages(transactions)


_EVIDENCE_TRANSACTION = {
    "transaction_id": "TXN_99",
    "case_id": "CASE_99",
    "documents": ["INV-9901", "PO-9901"],
    "missing_evidence": [],
    "evidence_confidence": 0.9,
    "notes": "Invoice and PO present.",
}

_INTAKE_DOCUMENTS = [
    {
        "doc_id": "INV-9901",
        "type": "invoice",
        "vendor": "Acme Supplies",
        "amount": 100.0,
        "currency": "USD",
        "date": "2026-01-01",
        "references": ["PO-9901"],
        "case_id": "CASE_99",
        "extraction_notes": None,
    },
    {
        "doc_id": "PO-9901",
        "type": "purchase_order",
        "vendor": "Acme Supply Co",  # deliberately different vendor spelling
        "amount": 100.0,
        "currency": "USD",
        "date": "2025-12-28",
        "references": [],
        "case_id": "CASE_99",
        "extraction_notes": None,
    },
]


def test_run_anomaly_agent_enforces_deterministic_join_keys():
    fake_finding = {
        "type": "vendor_mismatch",
        "documents": ["INV-9901", "PO-9901"],
        "severity": "medium",
        "confidence": 0.81,
        "explanation": "Vendor name differs between invoice and PO.",
    }
    fake_transaction = {
        "transaction_id": "wrong",
        "case_id": "wrong",
        "findings": [fake_finding],
    }
    client = _FakeClient([fake_transaction])

    result = run_anomaly_agent(_EVIDENCE_TRANSACTION, _INTAKE_DOCUMENTS, client=client)

    assert result["case_id"] == "CASE_99"
    assert result["transaction_id"] == "TXN_99"
    assert result["findings"] == [fake_finding]

    sent_message = client.messages.last_kwargs["messages"][0]["content"]
    # both the evidence map and the underlying document field values (e.g.
    # the mismatched vendor spellings) must reach the model
    assert "Acme Supplies" in sent_message
    assert "Acme Supply Co" in sent_message
    assert client.messages.last_kwargs["output_config"]["format"]["schema"] == OUTPUT_SCHEMA


def test_run_anomaly_agent_allows_empty_findings():
    client = _FakeClient(
        [{"transaction_id": "TXN_99", "case_id": "CASE_99", "findings": []}]
    )

    result = run_anomaly_agent(_EVIDENCE_TRANSACTION, _INTAKE_DOCUMENTS, client=client)

    assert result["findings"] == []


def test_run_anomaly_agent_raises_on_documents_from_a_different_case():
    other_case_doc = dict(_INTAKE_DOCUMENTS[0], case_id="CASE_01")
    with pytest.raises(ValueError):
        run_anomaly_agent(_EVIDENCE_TRANSACTION, [other_case_doc], client=_FakeClient([]))


def test_run_anomaly_agent_raises_when_model_returns_wrong_transaction_count():
    client = _FakeClient([])  # zero transactions instead of exactly one
    with pytest.raises(ValueError):
        run_anomaly_agent(_EVIDENCE_TRANSACTION, _INTAKE_DOCUMENTS, client=client)


def test_system_prompt_disambiguates_missing_types_from_mismatch_types():
    # Regression guard for the CASE_10/CASE_11 double-counting fix: a
    # present-but-conflicting PO/receipt must not also be scored as missing.
    # This can't be tested end-to-end without a live model call, but a
    # future edit accidentally dropping this clause should fail loudly here.
    assert "missing_po and missing_receipt apply only when" in SYSTEM_PROMPT
    assert "never additionally as missing_po/missing_receipt" in SYSTEM_PROMPT
