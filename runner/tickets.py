"""Finding ids and ticket text. One ticket per finding (one atomic mismatch)."""
from __future__ import annotations

import hashlib

TYPE_LABELS = {
    "missing_po": "Purchase order not among the documents provided",
    "missing_receipt": "Goods receipt not among the documents provided",
    "amount_mismatch": "Amounts do not agree between documents",
    "vendor_mismatch": "Vendor names do not agree between documents",
    "date_inconsistency": "Document dates are inconsistent",
    "currency_mismatch": "Currencies differ between documents",
    "tax_mismatch": "Tax arithmetic on the invoice does not reconcile",
    "duplicate_invoice": "Two invoices appear to cover the same transaction",
}

DISCLAIMER = (
    "This is a fact-check result produced by comparing the documents provided. It is a difference "
    "for the auditor to look into and resolve. It is not a conclusion that anything is wrong, and it "
    "is never an allegation of fraud. There may be an ordinary explanation (for example a document "
    "that exists but was not supplied, a timing difference, or a rounding or conversion effect)."
)


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def finding_id(finding_type: str, cited_hashes: list[str]) -> str:
    """Stable across runs: same finding type on the same document contents gives the same id."""
    digest = hashlib.sha256((finding_type + "|" + ",".join(sorted(set(cited_hashes)))).encode()).hexdigest()
    return f"F-{digest[:20]}"


def _money(doc: dict) -> str:
    if doc.get("amount") is None:
        return "no amount stated"
    return f'{doc.get("currency") or ""} {doc["amount"]:,.2f}'.strip()


def build_ticket(finding: dict, cited: list[dict], missing_attachments: list[str]) -> tuple[str, str]:
    """finding: {type, severity, explanation, documents}. cited: Intake dicts (+ '_file') of the cited
    documents. Returns (title, body). Only ids, extracted amounts and the agent's own explanation appear."""
    label = TYPE_LABELS.get(finding["type"], finding["type"])
    ids = ", ".join(finding["documents"]) or "(none)"
    title = f"Fact-check: {label} [{ids}]"
    lines = [
        "FACT-CHECK RESULT FOR AUDITOR REVIEW",
        "",
        f"What was found: {label}.",
        f"Detail: {finding['explanation']}",
        f"Suggested priority: {finding['severity']}",
        "",
        "Documents involved (attached to this ticket):",
    ]
    for d in cited:
        lines.append(f'- {d["doc_id"]} ({d["type"].replace("_", " ")}): {d["vendor"] or "vendor not stated"}, '
                     f'{_money(d)}, dated {d["date"] or "not stated"}  [file: {d["_file"]}]')
    for m in missing_attachments:
        lines.append(f"- {m}: cited by the check but its file could not be matched, so it is NOT attached")
    lines += ["", DISCLAIMER, "", "Please review the attached documents, confirm or correct the position with "
              "the vendor or internal records, and record the outcome on this ticket."]
    return title, "\n".join(lines)
