"""Tests for the upload file-to-document mapping. No API calls: the
Anthropic client is a fake."""

import json

import pytest

from file_map import build_file_map, make_unique_filenames
from intake_agent import (
    OUTPUT_SCHEMA,
    run_intake_agent_from_documents,
    _build_upload_schema,
)


class _Block:
    type = "text"

    def __init__(self, text):
        self.text = text


class _Response:
    def __init__(self, documents):
        self.content = [_Block(json.dumps({"documents": documents}))]


class _Messages:
    def __init__(self, documents):
        self.documents = documents
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return _Response(self.documents)


class _Client:
    def __init__(self, documents=()):
        self.messages = _Messages(list(documents))


def _doc(doc_id, source_file):
    return {
        "doc_id": doc_id, "type": "invoice", "vendor": "V", "amount": 1.0,
        "tax_amount": None, "subtotal": None, "currency": "INR", "date": None,
        "references": [], "case_id": "C", "extraction_notes": None,
        "source_file": source_file,
    }


# --- schema / enum ---------------------------------------------------------

def test_upload_schema_has_enum_of_uploaded_filenames_and_requires_it():
    schema = _build_upload_schema(["a.pdf", "b.png"])
    item = schema["properties"]["documents"]["items"]
    assert item["properties"]["source_file"] == {"type": "string", "enum": ["a.pdf", "b.png"]}
    assert "source_file" in item["required"]
    assert item["additionalProperties"] is False


def test_benchmark_schema_is_unchanged_by_building_an_upload_schema():
    _build_upload_schema(["a.pdf"])
    item = OUTPUT_SCHEMA["properties"]["documents"]["items"]
    assert "source_file" not in item["properties"]
    assert "source_file" not in item["required"]


def test_upload_call_sends_enum_schema_and_the_source_file_instruction():
    client = _Client([_doc("INV-1", "a.pdf")])
    run_intake_agent_from_documents("C", [("a.pdf", b"x"), ("b.pdf", b"y")], client=client)
    sent = client.messages.kwargs
    schema = sent["output_config"]["format"]["schema"]
    enum = schema["properties"]["documents"]["items"]["properties"]["source_file"]["enum"]
    assert enum == ["a.pdf", "b.pdf"]
    text_blocks = [b["text"] for b in sent["messages"][0]["content"] if b["type"] == "text"]
    assert "source_file" in text_blocks[0]
    assert "(Source file: a.pdf)" in text_blocks
    assert "(Source file: b.pdf)" in text_blocks


def test_intake_rejects_duplicate_filenames():
    with pytest.raises(ValueError):
        run_intake_agent_from_documents("C", [("a.pdf", b"x"), ("a.pdf", b"y")], client=_Client())


# --- unique filenames ------------------------------------------------------

def test_duplicate_names_are_made_unique_and_order_is_kept():
    assert make_unique_filenames(["a.pdf", "a.pdf", "b.pdf", "a.pdf"]) == [
        "a.pdf", "a (2).pdf", "b.pdf", "a (3).pdf"]


def test_generated_name_does_not_collide_with_a_real_upload():
    assert make_unique_filenames(["a.pdf", "a.pdf", "a (2).pdf"]) == ["a.pdf", "a (3).pdf", "a (2).pdf"]


def test_unique_names_keep_the_file_extension():
    assert make_unique_filenames(["x.PNG", "x.PNG"])[1].endswith(".PNG")
    assert make_unique_filenames(["noext", "noext"]) == ["noext", "noext (2)"]


# --- build_file_map --------------------------------------------------------

def test_simple_one_to_one_mapping():
    result = build_file_map([_doc("INV-1", "a.pdf"), _doc("PO-1", "b.pdf")], ["a.pdf", "b.pdf"])
    assert result == {
        "documents": [{"doc_id": "INV-1", "source_file": "a.pdf"},
                      {"doc_id": "PO-1", "source_file": "b.pdf"}],
        "ambiguous_doc_ids": [],
        "unmapped_files": [],
    }


def test_unmapped_file_is_reported():
    result = build_file_map([_doc("INV-1", "a.pdf")], ["a.pdf", "scan.png", "c.pdf"])
    assert result["unmapped_files"] == ["scan.png", "c.pdf"]
    assert result["ambiguous_doc_ids"] == []


def test_two_files_with_one_doc_id_are_ambiguous():
    result = build_file_map([_doc("INV-1", "a.pdf"), _doc("INV-1", "b.pdf")], ["a.pdf", "b.pdf"])
    assert result["documents"] == [{"doc_id": "INV-1", "source_file": "a.pdf"},
                                   {"doc_id": "INV-1", "source_file": "b.pdf"}]
    assert result["ambiguous_doc_ids"] == ["INV-1"]
    assert result["unmapped_files"] == []


def test_one_file_with_several_documents_is_not_ambiguous():
    docs = [_doc("INV-1", "bundle.pdf"), _doc("PO-1", "bundle.pdf"), _doc("REC-1", "bundle.pdf")]
    result = build_file_map(docs, ["bundle.pdf"])
    assert [d["doc_id"] for d in result["documents"]] == ["INV-1", "PO-1", "REC-1"]
    assert {d["source_file"] for d in result["documents"]} == {"bundle.pdf"}
    assert result["ambiguous_doc_ids"] == []
    assert result["unmapped_files"] == []


def test_same_doc_id_twice_from_one_file_is_listed_once():
    result = build_file_map([_doc("INV-1", "a.pdf"), _doc("INV-1", "a.pdf")], ["a.pdf"])
    assert result["documents"] == [{"doc_id": "INV-1", "source_file": "a.pdf"}]
    assert result["ambiguous_doc_ids"] == []


def test_unknown_or_missing_source_file_gives_none_and_leaves_file_unmapped():
    no_source = _doc("INV-1", "ghost.pdf")
    del_doc = {k: v for k, v in _doc("PO-1", None).items() if k != "source_file"}
    result = build_file_map([no_source, del_doc], ["a.pdf"])
    assert result["documents"] == [{"doc_id": "INV-1", "source_file": None},
                                   {"doc_id": "PO-1", "source_file": None}]
    assert result["unmapped_files"] == ["a.pdf"]
