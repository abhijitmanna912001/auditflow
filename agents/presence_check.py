"""Code-decided missing_po / missing_receipt findings.

The Anomaly Agent's model used to decide these two types, and it dropped or
invented them from run to run. They are a structural fact about the Intake
records, so run_anomaly_agent() now computes them here, after the model call,
and replaces whatever the model said about them (see merge_presence_findings).

Rule, per transaction that contains at least one document of type "invoice":
    no document of type "purchase_order" -> missing_po
    no document of type "receipt"        -> missing_receipt
One finding per type per transaction, even with several invoices. A document
that Intake typed wrongly (a PO read as "ledger_entry") is not recognised, so
the finding is raised. That is intended: the type is the only input, and every
finding is reviewed by a person anyway.

The explanation is a fixed template. It says only that no such document was
found among those provided - it never says the document does not exist and
never implies fraud or non-compliance.
"""

from __future__ import annotations

PRESENCE_TYPES = ("missing_po", "missing_receipt")

# Severity is fixed per type; confidence is 1.0 because the finding is
# computed, not judged (the Decision Agent uses the same 1.0 for "no findings").
PRESENCE_SEVERITY = "medium"
PRESENCE_CONFIDENCE = 1.0

_REQUIRED_DOC_TYPE = {"missing_po": "purchase_order", "missing_receipt": "receipt"}
_DOC_LABEL = {"missing_po": "purchase order", "missing_receipt": "receipt"}


def _explanation(finding_type: str, invoice_ids: list[str]) -> str:
    noun = "invoice" if len(invoice_ids) == 1 else "invoices"
    return (
        f"No {_DOC_LABEL[finding_type]} was found among the documents provided "
        f"for this transaction ({noun} {', '.join(invoice_ids)})."
    )


def presence_findings(evidence_transaction: dict, intake_documents: list[dict]) -> list[dict]:
    """The missing_po / missing_receipt findings for one transaction, in that
    order. Empty when the transaction has no invoice. `documents` is the
    transaction's invoice ids, sorted, so the first one (the finding's id
    anchor, see workpaper_agent.build_findings) does not depend on any model
    output."""
    doc_ids = set(evidence_transaction["documents"])
    types = {
        doc["doc_id"]: doc.get("type")
        for doc in intake_documents
        if doc["doc_id"] in doc_ids
    }
    invoice_ids = sorted(doc_id for doc_id, t in types.items() if t == "invoice")
    if not invoice_ids:
        return []
    present = set(types.values())
    return [
        {
            "type": finding_type,
            "documents": list(invoice_ids),
            "severity": PRESENCE_SEVERITY,
            "confidence": PRESENCE_CONFIDENCE,
            "explanation": _explanation(finding_type, invoice_ids),
        }
        for finding_type in PRESENCE_TYPES
        if _REQUIRED_DOC_TYPE[finding_type] not in present
    ]


def merge_presence_findings(
    model_findings: list[dict], evidence_transaction: dict, intake_documents: list[dict]
) -> list[dict]:
    """The model's findings without any missing_po / missing_receipt, followed
    by the code's. Code findings go last so the ids and the primary document of
    the model's other findings do not move."""
    kept = [f for f in model_findings if f.get("type") not in PRESENCE_TYPES]
    return kept + presence_findings(evidence_transaction, intake_documents)
