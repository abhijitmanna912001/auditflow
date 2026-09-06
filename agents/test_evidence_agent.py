"""Unit tests for the Evidence Agent that do not call the real API.

The Anthropic client is injected as a fake, so these run in CI without
network access or an ANTHROPIC_API_KEY.
"""

import json

import pytest

from evidence_agent import run_evidence_agent, _derive_transaction_id, OUTPUT_SCHEMA, SYSTEM_PROMPT


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


_INTAKE_DOC = {
    "doc_id": "INV-9901",
    "type": "invoice",
    "vendor": "Test Vendor",
    "amount": 100.0,
    "currency": "USD",
    "date": "2026-01-01",
    "references": ["PO-9901"],
    "case_id": "CASE_99",
    "extraction_notes": None,
}


def test_derive_transaction_id():
    assert _derive_transaction_id("CASE_04") == "TXN_04"
    assert _derive_transaction_id("CASE_99") == "TXN_99"


def test_derive_transaction_id_rejects_unexpected_format():
    with pytest.raises(ValueError):
        _derive_transaction_id("NOT_A_CASE_ID")


def test_run_evidence_agent_enforces_deterministic_join_keys():
    # Model echoes the wrong transaction_id/case_id - our code must override
    # them with the deterministically-derived values, not trust the model.
    fake_transaction = {
        "transaction_id": "wrong",
        "case_id": "wrong",
        "documents": ["INV-9901"],
        "missing_evidence": ["purchase_order"],
        "evidence_confidence": 0.6,
        "notes": "Invoice references a PO with no matching fixture.",
    }
    client = _FakeClient([fake_transaction])

    result = run_evidence_agent([_INTAKE_DOC], client=client)

    assert result["case_id"] == "CASE_99"
    assert result["transaction_id"] == "TXN_99"
    assert result["documents"] == ["INV-9901"]
    assert result["missing_evidence"] == ["purchase_order"]
    sent_message = client.messages.last_kwargs["messages"][0]["content"]
    assert "INV-9901" in sent_message
    assert client.messages.last_kwargs["output_config"]["format"]["schema"] == OUTPUT_SCHEMA


def test_run_evidence_agent_raises_on_empty_input():
    with pytest.raises(ValueError):
        run_evidence_agent([], client=_FakeClient([]))


def test_run_evidence_agent_raises_on_mixed_case_ids():
    other_doc = dict(_INTAKE_DOC, doc_id="INV-1", case_id="CASE_01")
    with pytest.raises(ValueError):
        run_evidence_agent([_INTAKE_DOC, other_doc], client=_FakeClient([]))


def test_run_evidence_agent_raises_when_model_returns_wrong_transaction_count():
    client = _FakeClient([])  # zero transactions instead of exactly one
    with pytest.raises(ValueError):
        run_evidence_agent([_INTAKE_DOC], client=client)


def test_system_prompt_guards_against_the_consistency_and_payment_fallacies():
    # Regression guard for the CASE_06 fix: internal consistency among
    # present documents, or a successful payment, must not be read as proof
    # nothing is missing. Can't test the model's actual behavior without a
    # live call, but a future edit dropping this clause should fail loudly.
    assert "never proves an absent document type wasn't required" in SYSTEM_PROMPT
    assert "successful payment status is not proof" in SYSTEM_PROMPT
