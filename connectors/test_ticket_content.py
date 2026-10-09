"""Tests for the pure ticket-content helpers. No network."""

import pytest

from connectors.ticket_content import (
    build_description,
    build_subject,
    extract_key,
    find_existing_ticket,
    normalise_company,
    plan_attachments,
)

FID = "AF-1a2b3c4d5e"


def test_normalise_company():
    assert normalise_company("  Acme   Ltd \n") == ("Acme Ltd", "acme ltd")
    assert normalise_company("STRASSE")[1] == "strasse"
    with pytest.raises(ValueError):
        normalise_company("   ")


def test_subject_basic_uses_en_dash():
    assert build_subject(FID, "Vendor mismatch", "INV-1") == f"[{FID}] Vendor mismatch – INV-1"


def test_subject_truncated_keeps_key_and_strips_control_chars():
    subject = build_subject(FID, "Bad\nlabel\x00\t" + "x" * 400, "INV\r\n-1\x07")
    assert len(subject) <= 255
    assert subject.startswith(f"[{FID}] ")
    assert extract_key(subject) == FID
    assert all(ord(c) >= 32 and c != "\x7f" for c in subject)


def test_subject_exactly_255_not_cut():
    label = "y" * (255 - len(f"[{FID}] ") - len(" – D"))
    assert len(build_subject(FID, label, "D")) == 255


@pytest.mark.parametrize(
    "subject,expected",
    [
        (f"[{FID}] x", FID),
        (f"[{FID}-2] x", f"{FID}-2"),
        (f" [{FID}] x", None),
        (f"x [{FID}]", None),
        ("[AF-XYZ] x", None),
        ("[AF-1a2b3c4d5e-] x", None),
        (None, None),
    ],
)
def test_extract_key(subject, expected):
    assert extract_key(subject) == expected


def test_find_existing_ticket_exact_equality():
    t1 = {"subject": f"[{FID}-2] second", "ticketNumber": "2"}
    t2 = {"subject": f"[{FID}] first", "ticketNumber": "1"}
    assert find_existing_ticket([t1], FID) is None
    assert find_existing_ticket([t1, t2], FID) is t2
    assert find_existing_ticket([t1, t2], f"{FID}-2") is t1
    assert find_existing_ticket([{"subject": None}, {}], FID) is None


def _map(*pairs):
    return [{"doc_id": d, "source_file": f} for d, f in pairs]


def _finding(**kw):
    base = {"documents": [], "transaction_documents": [], "primary_document": "INV-1"}
    base.update(kw)
    return base


def test_plan_cited_documents_preferred_over_transaction_documents():
    f = _finding(documents=["B", "A"], transaction_documents=["C"])
    m = _map(("A", "a.pdf"), ("B", "b.pdf"), ("C", "c.pdf"))
    plan = plan_attachments(f, m, [], {"a.pdf": 10, "b.pdf": 10, "c.pdf": 10})
    assert [a["filename"] for a in plan["attach"]] == ["b.pdf", "a.pdf"]  # cited order


def test_plan_falls_back_to_transaction_documents_and_dedupes():
    f = _finding(documents=[], transaction_documents=["A", "B", "A"])
    m = _map(("A", "x.pdf"), ("B", "x.pdf"))  # one file holds two documents
    plan = plan_attachments(f, m, [], {"x.pdf": 5})
    assert plan["doc_ids"] == ["A", "B"]
    assert len(plan["attach"]) == 1
    assert plan["attach"][0]["doc_ids"] == ["A", "B"]


def test_plan_unmapped_and_not_uploaded():
    f = _finding(documents=["A", "B", "C"])
    m = _map(("A", None), ("B", "gone.pdf"))  # C absent, B's file not uploaded
    plan = plan_attachments(f, m, [], {})
    assert plan["attach"] == []
    assert [n["doc_id"] for n in plan["no_file"]] == ["A", "B", "C"]
    assert all(n["reason"] for n in plan["no_file"])


def test_plan_ambiguous_attaches_all_candidates():
    f = _finding(documents=["A"])
    m = _map(("A", "one.pdf"), ("A", "two.pdf"))
    plan = plan_attachments(f, m, ["A"], {"one.pdf": 1, "two.pdf": 1})
    assert [a["filename"] for a in plan["attach"]] == ["one.pdf", "two.pdf"]
    assert plan["ambiguous"][0]["doc_id"] == "A"
    assert plan["ambiguous"][0]["files"] == ["one.pdf", "two.pdf"]
    assert plan["ambiguous"][0]["reason"]


def test_plan_per_file_limit_boundary():
    f = _finding(documents=["A", "B"])
    m = _map(("A", "ok.pdf"), ("B", "big.pdf"))
    plan = plan_attachments(f, m, [], {"ok.pdf": 19_000_000, "big.pdf": 19_000_001})
    assert [a["filename"] for a in plan["attach"]] == ["ok.pdf"]
    assert [a["filename"] for a in plan["not_attached_size"]] == ["big.pdf"]
    assert plan["not_attached_size"][0]["reason"]


def test_plan_ticket_total_limit():
    f = _finding(documents=["A", "B", "C", "D"])
    m = _map(("A", "a"), ("B", "b"), ("C", "c"), ("D", "d"))
    sizes = {"a": 19_000_000, "b": 19_000_000, "c": 12_000_000, "d": 1_000_000}
    plan = plan_attachments(f, m, [], sizes)
    # 19 + 19 = 38; c would make 50.0 + ... 38 + 12 = 50 exactly -> fits; d would exceed
    assert [a["filename"] for a in plan["attach"]] == ["a", "b", "c"]
    assert [a["filename"] for a in plan["not_attached_size"]] == ["d"]
    sizes["c"] = 12_000_001
    plan = plan_attachments(f, m, [], sizes)
    assert [a["filename"] for a in plan["attach"]] == ["a", "b", "d"]  # later small file still fits
    assert [a["filename"] for a in plan["not_attached_size"]] == ["c"]


def test_description_escapes_everything():
    evil = '<script>alert("x")</script> & \'q\''
    finding = {
        "label": evil,
        "primary_document": evil,
        "explanation": evil,
        "documents": [evil, "B"],
        "transaction_documents": [],
    }
    m = _map((evil, evil + ".pdf"), ("B", None))
    plan = plan_attachments(finding, m, [], {evil + ".pdf": 3})
    out = build_description(finding, evil, plan)
    assert "<script" not in out
    assert "&lt;script&gt;" in out
    assert "&quot;" in out and "&#x27;" in out
    import re

    assert set(re.findall(r"</?([a-z]+)", out)) <= {"p", "br", "b", "ul", "li"}


def test_description_sections():
    finding = {
        "label": "Vendor mismatch",
        "primary_document": "INV-1",
        "explanation": "Names differ.",
        "documents": ["INV-1", "PO-1", "GRN-1", "X-1"],
        "transaction_documents": [],
    }
    m = _map(("INV-1", "inv.pdf"), ("PO-1", "po.pdf"), ("GRN-1", "grn.pdf"), ("X-1", None))
    plan = plan_attachments(finding, m, [], {"inv.pdf": 1, "po.pdf": 20_000_000, "grn.pdf": 1})
    out = build_description(finding, "Acme Ltd", plan)
    for text in (
        "Audit exception:",
        "Company:</b> Acme Ltd",
        "Document:</b> INV-1",
        "Related documents:</b> PO-1, GRN-1, X-1",
        "Why it was flagged:",
        "Names differ.",
        "Attachments:",
        "Not attached because of size: po.pdf",
        "Not uploaded: no file for X-1",
        "inv.pdf: Linked because AuditFlow read it as INV-1",
        "This is a document check result for the auditor to review. "
        "It is not a conclusion about fraud or compliance.",
    ):
        assert text in out
