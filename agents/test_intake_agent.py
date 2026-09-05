"""Unit tests for the Intake Agent that do not call the real API.

The Anthropic client is injected as a fake, so these run in CI without
network access or an ANTHROPIC_API_KEY.
"""

import json

import pytest

from intake_agent import run_intake_agent, OUTPUT_SCHEMA


class _FakeTextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, documents):
        self.content = [_FakeTextBlock(json.dumps({"documents": documents}))]


class _FakeMessages:
    def __init__(self, documents):
        self._documents = documents
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeResponse(self._documents)


class _FakeClient:
    def __init__(self, documents):
        self.messages = _FakeMessages(documents)


def test_run_intake_agent_reads_fixtures_and_returns_parsed_documents(tmp_path):
    case_dir = tmp_path / "CASE_99"
    case_dir.mkdir()
    (case_dir / "INV-9901.txt").write_text("TAX INVOICE\nDocument ID: INV-9901\n")

    fake_doc = {
        "doc_id": "INV-9901",
        "type": "invoice",
        "vendor": "Test Vendor",
        "amount": 100.0,
        "currency": "USD",
        "date": "2026-01-01",
        "references": [],
        "case_id": "CASE_99",
        "extraction_notes": None,
    }
    client = _FakeClient([fake_doc])

    results = run_intake_agent(str(case_dir), client=client)

    assert results == [fake_doc]
    sent_message = client.messages.last_kwargs["messages"][0]["content"]
    assert "INV-9901" in sent_message
    assert client.messages.last_kwargs["output_config"]["format"]["schema"] == OUTPUT_SCHEMA


def test_run_intake_agent_raises_on_missing_folder(tmp_path):
    with pytest.raises(FileNotFoundError):
        run_intake_agent(str(tmp_path / "CASE_DOES_NOT_EXIST"), client=_FakeClient([]))


def test_run_intake_agent_raises_on_empty_folder(tmp_path):
    case_dir = tmp_path / "CASE_EMPTY"
    case_dir.mkdir()
    with pytest.raises(FileNotFoundError):
        run_intake_agent(str(case_dir), client=_FakeClient([]))
