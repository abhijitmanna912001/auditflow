"""Unit tests for build_findings. No API calls."""

from workpaper_agent import build_findings


def _workpaper(document="INV-1", evidence=("INV-1", "PO-1")):
    return {"rows": [{"document": document, "evidence": list(evidence)}]}


def _finding(ftype, documents=(), severity="medium", confidence=0.9):
    return {
        "type": ftype,
        "documents": list(documents),
        "severity": severity,
        "confidence": confidence,
        "explanation": f"explanation for {ftype}",
    }


def test_no_findings_gives_empty_list():
    assert build_findings({"findings": []}, _workpaper()) == []


def test_missing_document_finding_still_has_transaction_documents():
    result = build_findings({"findings": [_finding("missing_po")]}, _workpaper())
    assert result[0]["documents"] == []
    assert result[0]["transaction_documents"] == ["INV-1", "PO-1"]
    assert result[0]["row_document"] == "INV-1"
    assert result[0]["primary_document"] == "INV-1"
    assert result[0]["explanation"] == "explanation for missing_po"
    assert result[0]["severity"] == "medium"
    assert result[0]["confidence"] == 0.9


def test_labels_map_correctly():
    mapping = {
        "duplicate_invoice": "Duplicate invoice",
        "amount_mismatch": "Amount mismatch",
        "missing_po": "Missing purchase order",
        "missing_receipt": "Missing receipt",
        "vendor_mismatch": "Vendor mismatch",
        "date_inconsistency": "Date inconsistency",
        "currency_mismatch": "Currency mismatch",
        "tax_mismatch": "Tax calculation mismatch",
    }
    result = build_findings(
        {"findings": [_finding(t) for t in mapping]}, _workpaper()
    )
    assert {f["type"]: f["label"] for f in result} == mapping


def test_unknown_type_falls_back_to_raw_type():
    result = build_findings({"findings": [_finding("weird_new_type")]}, _workpaper())
    assert result[0]["label"] == "weird_new_type"


def test_duplicate_ids_get_numeric_suffixes_in_order():
    anomaly = {
        "findings": [
            _finding("amount_mismatch", ["A"]),
            _finding("amount_mismatch", ["B"]),
            _finding("amount_mismatch", ["C"]),
            _finding("missing_po"),
        ]
    }
    ids = [f["finding_id"] for f in build_findings(anomaly, _workpaper())]
    base = ids[0]
    assert ids[1] == base + "-2"
    assert ids[2] == base + "-3"
    assert len(set(ids)) == 4
    assert [f["documents"] for f in build_findings(anomaly, _workpaper())][:3] == [
        ["A"],
        ["B"],
        ["C"],
    ]
