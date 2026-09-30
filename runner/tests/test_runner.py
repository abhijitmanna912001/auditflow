"""Offline tests (no API): grouping rules, finding ids, local source and sink."""
from runner.grouping import amount_rule, group_documents
from runner.sink import LocalTicketSink
from runner.source import LocalFolderSource
from runner.tickets import finding_id


def doc(doc_id, typ, amount, refs=(), vendor="Acme Pvt. Ltd."):
    return {"doc_id": doc_id, "type": typ, "vendor": vendor, "amount": amount, "currency": "INR",
            "date": "2026-07-01", "references": list(refs), "tax_amount": None, "extraction_notes": None}


def no_model(kind, system, user, schema):          # any model call in these tests is a bug
    raise AssertionError("model should not be called")


def test_amount_rule():
    assert amount_rule(doc("B", "bank_statement", 100.0), [100.0], False)[0]
    assert not amount_rule(doc("B", "bank_statement", 130.0), [100.0], True)[0]
    assert amount_rule(doc("B", "bank_statement", None), [100.0], True)[0]
    assert not amount_rule(doc("B", "bank_statement", None), [100.0], False)[0]


def test_reference_attach_and_amount_mismatch_unplaced():
    docs = [doc("PO-1", "purchase_order", 100.0), doc("INV-1", "invoice", 100.0, ["PO-1"]),
            doc("BNK-1", "bank_statement", 100.0, ["INV-1"]), doc("BNK-2", "bank_statement", 130.0, ["INV-1"])]
    res = group_documents(docs, model_call=lambda k, s, u, sc: {"clusters": []})
    assert res["groups"]["G01"]["members"] == ["BNK-1", "INV-1", "PO-1"]
    assert [u["doc_id"] for u in res["unplaced"]] == ["BNK-2"]
    assert "amount" in res["unplaced"][0]["reason"]


def test_shared_document_never_joins_groups():
    docs = [doc("INV-1", "invoice", 100.0, ["PO-1"]), doc("INV-2", "invoice", 200.0, ["PO-2"]),
            doc("BNK-M", "bank_statement", None, ["INV-1", "INV-2"])]
    res = group_documents(docs, model_call=no_model)
    assert len(res["groups"]) == 2 and res["shared"] == {"BNK-M": ["G01", "G02"]}
    assert "INV-2" not in res["groups"]["G01"]["members"]


def test_lone_po_is_reported_not_dropped():
    docs = [doc("PO-9", "purchase_order", 50.0)]
    res = group_documents(docs, model_call=no_model)
    assert res["groups"] == {} and res["unplaced"][0]["doc_id"] == "PO-9"


def test_finding_id_stable_and_order_free():
    assert finding_id("missing_po", ["a", "b"]) == finding_id("missing_po", ["b", "a"])
    assert finding_id("missing_po", ["a"]) != finding_id("missing_receipt", ["a"])
    assert finding_id("missing_po", ["a"]) != finding_id("missing_po", ["c"])


def test_local_sink_and_source(tmp_path):
    src = tmp_path / "in"; src.mkdir(); (src / "a.pdf").write_bytes(b"x")
    assert LocalFolderSource(src).list_files() == ["a.pdf"]
    sink = LocalTicketSink(tmp_path / "out")
    assert sink.find_existing("F-1") is None
    sink.create_ticket("t", "b", [("a.pdf", b"x")], "F-1")
    assert sink.find_existing("F-1") == "F-1"
    assert (tmp_path / "out/tickets/F-1/attachments/a.pdf").read_bytes() == b"x"
