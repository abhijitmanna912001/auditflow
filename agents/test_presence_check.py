"""Offline tests for the code-decided missing_po / missing_receipt findings.

Fixtures are hand-built Intake-shaped records for all 14 benchmark cases, with
types taken from each dataset file's title line (PURCHASE ORDER; GOODS RECEIPT
NOTE, SERVICE ACCEPTANCE RECEIPT and SERVICE COMPLETION RECEIPT are receipts).
They test the rule, not Intake's typing. No model or network call is made.
"""

import json
from pathlib import Path

import pytest

from anomaly_agent import collect_model_findings, run_anomaly_agent
from finding_id import make_finding_id
from presence_check import merge_presence_findings, presence_findings
from workpaper_agent import build_findings

DATASET = Path(__file__).resolve().parent.parent / "dataset"

_BNK, _LED, _INV, _PO, _REC = "bank_statement", "ledger_entry", "invoice", "purchase_order", "receipt"


def _standard(n, po=True, rec=True, invoices=("",)):
    docs = [(f"INV-{n}{suffix}", _INV) for suffix in invoices]
    if po:
        docs.append((f"PO-{n}", _PO))
    if rec:
        docs.append((f"REC-{n}", _REC))
    return docs + [(f"BNK-{n}", _BNK), (f"LED-{n}", _LED)]


# case number -> (documents present, expected missing_* types)
CASES = {
    1: (_standard(1001), []),
    2: (_standard(1002), []),
    3: (_standard(1003, invoices=("-A", "-B")), []),
    4: (_standard(1004), []),
    5: (_standard(1005, po=False), ["missing_po"]),
    6: (_standard(1006, rec=False), ["missing_receipt"]),
    7: (_standard(1007), []),
    8: (_standard(1008), []),
    9: (_standard(1009, rec=False, invoices=("-A", "-B")), ["missing_receipt"]),
    10: (_standard(1010), []),
    11: (_standard(1011, po=False), ["missing_po"]),
    12: (_standard(1012, rec=False), ["missing_receipt"]),
    13: (_standard(1013), []),
    14: (_standard(1014), []),
}


def _intake(case_id, docs):
    return [
        {
            "doc_id": doc_id, "type": doc_type, "vendor": "V", "amount": 100.0,
            "tax_amount": None, "subtotal": None, "currency": "INR", "date": "2026-01-01",
            "references": [], "case_id": case_id, "extraction_notes": None,
        }
        for doc_id, doc_type in docs
    ]


def _evidence(case_id, docs):
    return {
        "transaction_id": "TXN_" + case_id[-2:], "case_id": case_id,
        "documents": [doc_id for doc_id, _ in docs], "missing_evidence": [],
        "evidence_confidence": 0.9, "notes": "n",
    }


def _case(number):
    case_id = f"CASE_{number:02d}"
    docs, expected = CASES[number]
    return case_id, docs, expected, _evidence(case_id, docs), _intake(case_id, docs)


def _model_finding(ftype, documents=("INV-1",), explanation="model text"):
    return {"type": ftype, "documents": list(documents), "severity": "high",
            "confidence": 0.6, "explanation": explanation}


class _Block:
    def __init__(self, text):
        self.type, self.text = "text", text


class _Client:
    """Fake Anthropic client returning one Anomaly transaction."""

    def __init__(self, findings):
        self._findings = findings
        self.messages = self

    def create(self, **kwargs):
        body = {"transactions": [{"transaction_id": "x", "case_id": "x", "findings": self._findings}]}
        return type("R", (), {"content": [_Block(json.dumps(body))]})()


def _run(number, model_findings):
    _, _, _, evidence, intake = _case(number)
    return run_anomaly_agent(evidence, intake, client=_Client(model_findings))


# ---- the rule against ground truth ----------------------------------------


@pytest.mark.parametrize("number", sorted(CASES))
def test_rule_matches_ground_truth_for_every_case(number):
    _, _, expected, evidence, intake = _case(number)
    found = presence_findings(evidence, intake)
    assert [f["type"] for f in found] == expected


@pytest.mark.parametrize("number", sorted(CASES))
def test_fixture_expectations_agree_with_dataset_ground_truth(number):
    truth = json.loads((DATASET / f"case_{number:02d}.json").read_text())
    truth_missing = sorted(f["type"] for f in truth["expected_findings"] if f["type"].startswith("missing_"))
    assert truth_missing == sorted(CASES[number][1])


@pytest.mark.parametrize("number", sorted(CASES))
def test_every_case_through_run_anomaly_agent_with_a_silent_model(number):
    # the model reports nothing at all: the result still has exactly the
    # expected presence findings
    result = _run(number, [])
    assert [f["type"] for f in result["findings"]] == CASES[number][1]


def test_findings_cite_the_transactions_invoices_sorted():
    _, _, _, evidence, intake = _case(9)
    for finding in presence_findings(evidence, intake):
        assert finding["documents"] == ["INV-1009-A", "INV-1009-B"]
        assert finding["severity"] == "medium"
        assert finding["confidence"] == 1.0


def test_two_invoices_give_one_finding_per_type():
    _, _, _, evidence, intake = _case(9)
    assert [f["type"] for f in presence_findings(evidence, intake)] == ["missing_receipt"]


def test_invoice_with_po_and_receipt_gets_none():
    _, _, _, evidence, intake = _case(1)
    assert presence_findings(evidence, intake) == []
    assert _run(1, [])["findings"] == []


def test_no_invoice_gives_none():
    docs = [("PO-1", _PO), ("BNK-1", _BNK)]
    assert presence_findings(_evidence("CASE_90", docs), _intake("CASE_90", docs)) == []


def test_documents_outside_the_transaction_are_ignored():
    docs = [("INV-1", _INV)]
    evidence = _evidence("CASE_90", docs)
    intake = _intake("CASE_90", docs + [("PO-1", _PO), ("REC-1", _REC)])  # not in the evidence map
    assert [f["type"] for f in presence_findings(evidence, intake)] == ["missing_po", "missing_receipt"]


def test_wrongly_typed_document_produces_a_flag():
    # Intended behaviour: the Intake type is the only input. A PO that Intake
    # typed as ledger_entry is not recognised, so missing_po is raised and a
    # person reviews it (every finding is routed to human review anyway).
    number = 7
    case_id, docs, _, _, _ = _case(number)
    mistyped = [(d, _LED if d.startswith("PO-") else t) for d, t in docs]
    found = presence_findings(_evidence(case_id, mistyped), _intake(case_id, mistyped))
    assert [f["type"] for f in found] == ["missing_po"]


# ---- merging with the model's findings ------------------------------------


def test_model_made_missing_findings_are_removed_and_replaced():
    # CASE_05 truly lacks a PO. The model reports a wrong missing_receipt, a
    # missing_po with its own documents and text, and a second missing_po.
    model = [
        _model_finding("missing_receipt", ["REC-1005"], "model says no receipt"),
        _model_finding("missing_po", ["REC-1005", "BNK-1005"], "model says missing PO"),
        _model_finding("missing_po", ["LED-1005"], "again"),
    ]
    findings = _run(5, model)["findings"]
    assert [f["type"] for f in findings] == ["missing_po"]
    assert findings[0]["documents"] == ["INV-1005"]
    assert findings[0]["explanation"] == (
        "No purchase order was found among the documents provided for this transaction (invoice INV-1005)."
    )
    assert findings[0]["confidence"] == 1.0 and findings[0]["severity"] == "medium"


def test_dropped_missing_finding_is_restored():
    assert [f["type"] for f in _run(6, [])["findings"]] == ["missing_receipt"]
    assert [f["type"] for f in _run(11, [])["findings"]] == ["missing_po"]


def test_model_hallucinated_missing_finding_is_removed():
    # CASE_04 has a PO and a receipt; a model-made missing_po must not survive
    assert _run(4, [_model_finding("missing_po", ["INV-1004"])])["findings"] == []


def test_models_other_findings_are_kept_and_come_first():
    other = _model_finding("amount_mismatch", ["INV-1006", "PO-1006"])
    model = [_model_finding("missing_receipt", ["PO-1006"]), other]
    findings = _run(6, model)["findings"]
    assert [f["type"] for f in findings] == ["amount_mismatch", "missing_receipt"]
    assert findings[0] == other


def test_no_duplicate_findings_even_with_repeated_model_output():
    model = [_model_finding("missing_receipt", ["PO-1009"])] * 3
    findings = _run(9, model)["findings"]
    keys = [(f["type"], tuple(f["documents"])) for f in findings]
    assert len(keys) == len(set(keys)) == 1
    again = merge_presence_findings(findings, *_case(9)[3:])
    assert again == findings  # merging is idempotent


def test_explanation_never_mentions_fraud_or_non_compliance():
    for number in CASES:
        for finding in _run(number, [])["findings"]:
            text = finding["explanation"].lower()
            for word in ("fraud", "non-compliance", "noncompliance", "non compliance", "does not exist"):
                assert word not in text
    # and the fixed template for both types, with several invoices
    _, _, _, evidence, intake = _case(3)
    intake = [d for d in intake if d["type"] not in (_PO, _REC)]
    assert [f["explanation"] for f in presence_findings(evidence, intake)] == [
        "No purchase order was found among the documents provided for this transaction "
        "(invoices INV-1003-A, INV-1003-B).",
        "No receipt was found among the documents provided for this transaction "
        "(invoices INV-1003-A, INV-1003-B).",
    ]


def test_model_findings_are_collected_before_the_presence_step():
    model = [_model_finding("missing_po", ["INV-1004"]), _model_finding("amount_mismatch", ["INV-1004"])]
    with collect_model_findings() as collected:
        result = _run(4, model)
    assert collected == [model]
    assert [f["type"] for f in result["findings"]] == ["amount_mismatch"]
    # off by default: nothing is retained outside the context manager
    assert _run(4, model)["findings"] == result["findings"]


# ---- ids -------------------------------------------------------------------


def _workpaper_for(findings):
    # the workpaper row's document is the first document across findings
    first = findings[0]["documents"][0]
    return {"rows": [{"document": first, "evidence": [first]}]}


def test_ids_are_anchored_on_the_invoice_and_stable_across_calls():
    expected = {
        ("missing_receipt", 6): make_finding_id("missing_receipt", "INV-1006"),
        ("missing_po", 5): make_finding_id("missing_po", "INV-1005"),
        ("missing_receipt", 9): make_finding_id("missing_receipt", "INV-1009-A"),
    }
    # different model output each time: other documents listed first, different
    # explanations, finding dropped on one call
    variants = [
        [_model_finding("missing_receipt", ["PO-1006", "INV-1006"])],
        [_model_finding("missing_receipt", ["BNK-1006"])],
        [],
    ]
    for ftype, number in expected:
        ids = set()
        for i in range(3):
            model = variants[i] if number == 6 else [_model_finding(ftype, ["LED-%d" % (1000 + number)])]
            anomaly = _run(number, model)
            built = build_findings(anomaly, _workpaper_for(anomaly["findings"]))
            ids.add(next(f["finding_id"] for f in built if f["type"] == ftype))
        assert ids == {expected[(ftype, number)]}


def test_ids_stay_anchored_on_the_invoice_when_the_row_document_is_another_document():
    anomaly = {"findings": presence_findings(*_case(6)[3:])}
    row = {"rows": [{"document": "PO-1006", "evidence": ["PO-1006", "INV-1006"]}]}
    built = build_findings(anomaly, row)
    assert built[0]["finding_id"] == make_finding_id("missing_receipt", "INV-1006")


def test_other_finding_types_keep_the_row_primary_document_id():
    anomaly = {"findings": [_model_finding("amount_mismatch", ["PO-1006", "INV-1006"])]}
    row = {"rows": [{"document": "PO-1006", "evidence": ["PO-1006"]}]}
    assert build_findings(anomaly, row)[0]["finding_id"] == make_finding_id("amount_mismatch", "PO-1006")


def test_presence_finding_without_documents_falls_back_to_the_row_document():
    anomaly = {"findings": [_model_finding("missing_po", [])]}
    row = {"rows": [{"document": "INV-1", "evidence": ["INV-1"]}]}
    assert build_findings(anomaly, row)[0]["finding_id"] == make_finding_id("missing_po", "INV-1")


def test_ids_are_unique_within_a_transaction():
    _, _, _, evidence, intake = _case(1)
    docs = [(d["doc_id"], d["type"]) for d in intake if d["type"] == _INV]
    intake = _intake("CASE_01", docs)
    anomaly = {"findings": presence_findings(evidence, intake)}
    built = build_findings(anomaly, _workpaper_for(anomaly["findings"]))
    ids = [f["finding_id"] for f in built]
    assert [f["type"] for f in built] == ["missing_po", "missing_receipt"]
    assert len(set(ids)) == 2
