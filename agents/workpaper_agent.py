"""Workpaper Agent for AuditFlow.

Implements docs/agent-spec.md section 5: compiles all of a case's Decision
Agent outputs into the final workpaper JSON the frontend renders.

The spec's declared input is "all Decision Agent outputs for a case," and
says each one carries everything Workpaper needs. That's true for a
transaction WITH findings (a finding's `documents` list gives both
`document` and `evidence`), but not for a CLEAN transaction: Decision's
output for a clean transaction is just
{transaction_id, case_id, action, confidence, reason, thresholds_used,
findings: []} - there is no document ID anywhere in it, yet the row schema
requires `document` and `evidence` for every row, clean or not. So
run_workpaper_agent() also takes the case's Evidence Agent transactions,
used only as a fallback source of document IDs for clean rows (Evidence
Agent always lists every document belonging to a transaction, regardless of
whether it turned out clean).

What's actually delegated to the model: only the plain-language `finding`
label for rows that have findings (e.g. "Vendor mismatch") - the one part
of this job that's genuine natural-language summarization. Everything else
(`document`, `evidence`, `confidence`, `action`, the whole `summary` block,
and "Clean" for findings-free rows) is computed deterministically in code,
consistent with how decision_agent.py handles its own mechanical fields. If
every transaction in a case is clean, no API call is made at all - there is
nothing left for the model to summarize.

Usage:
    python3 agents/workpaper_agent.py dataset/CASE_01/ dataset/CASE_04/
"""

from __future__ import annotations

import json
import sys

import anthropic

from anomaly_agent import run_anomaly_agent
from decision_agent import run_decision_agent
from evidence_agent import run_evidence_agent
from intake_agent import run_intake_agent

MODEL = "claude-sonnet-5"

DEFAULT_ASSUMED_MINUTES_PER_ITEM = 3

# Copied verbatim from docs/agent-spec.md section 5 ("System prompt:").
SYSTEM_PROMPT = (
    "You are the Workpaper Agent for AuditFlow. You receive all Decision "
    "Agent outputs for a case. Compile a workpaper: one row per transaction "
    "with document, finding (plain-language summary, or Clean if none), "
    "evidence (document IDs), confidence, and action. Add a summary block: "
    "items_reviewed, auto_cleared count, human_review count, critical count "
    "(severity=high items), and an estimated_minutes_saved calculated as "
    "(auto_cleared_count times assumed_minutes_per_item), where "
    "assumed_minutes_per_item is a configurable input (default 3). State "
    "the assumption explicitly in the output - never present the "
    "time-saved number without it."
)

ACTIONS = ["auto_clear", "human_review"]

_ROW_SCHEMA = {
    "type": "object",
    "properties": {
        "document": {"type": ["string", "null"]},
        "finding": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number"},
        "action": {"type": "string", "enum": ACTIONS},
    },
    "required": ["document", "finding", "evidence", "confidence", "action"],
    "additionalProperties": False,
}

_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "items_reviewed": {"type": "integer"},
        "auto_cleared": {"type": "integer"},
        "human_review": {"type": "integer"},
        "critical": {"type": "integer"},
        "assumed_minutes_per_item": {"type": "number"},
        "estimated_minutes_saved": {"type": "number"},
    },
    "required": [
        "items_reviewed",
        "auto_cleared",
        "human_review",
        "critical",
        "assumed_minutes_per_item",
        "estimated_minutes_saved",
    ],
    "additionalProperties": False,
}

# Full Workpaper Agent output shape, per the spec - used to document/
# validate the final returned dict (not sent to the model as-is; see
# _FINDING_LABEL_REQUEST_SCHEMA below).
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "case_id": {"type": "string"},
        "rows": {"type": "array", "items": _ROW_SCHEMA},
        "summary": _SUMMARY_SCHEMA,
    },
    "required": ["case_id", "rows", "summary"],
    "additionalProperties": False,
}

# Schema actually requested from the model: one short plain-language finding
# label per transaction that has findings (see module docstring).
_FINDING_LABEL_SCHEMA = {
    "type": "object",
    "properties": {
        "transaction_id": {"type": "string"},
        "finding_summary": {"type": "string"},
    },
    "required": ["transaction_id", "finding_summary"],
    "additionalProperties": False,
}
_FINDING_LABEL_REQUEST_SCHEMA = {
    "type": "object",
    "properties": {"rows": {"type": "array", "items": _FINDING_LABEL_SCHEMA}},
    "required": ["rows"],
    "additionalProperties": False,
}


def _union_finding_documents(findings: list[dict]) -> list[str]:
    """Documents referenced by any finding, in first-seen order, deduped."""
    seen: list[str] = []
    for finding in findings:
        for doc_id in finding["documents"]:
            if doc_id not in seen:
                seen.append(doc_id)
    return seen


def _build_finding_label_message(transactions_with_findings: list[dict]) -> str:
    parts = [
        "For each transaction below, write a short plain-language finding "
        'label for its workpaper row (a few words, e.g. "Vendor mismatch" '
        'or "Amount mismatch; missing PO" if there are several) '
        "summarizing its finding(s). This is a compact label, not a full "
        "explanation sentence.\n"
    ]
    for transaction in transactions_with_findings:
        parts.append(
            f"Transaction ID: {transaction['transaction_id']}\n"
            f"Findings: {json.dumps(transaction['findings'], indent=2)}"
        )
    return "\n\n".join(parts)


def _generate_finding_labels(
    transactions_with_findings: list[dict], client: anthropic.Anthropic | None = None
) -> dict[str, str]:
    """One API call covering every transaction that has findings; returns
    {transaction_id: finding_summary}."""
    client = client or anthropic.Anthropic()
    user_message = _build_finding_label_message(transactions_with_findings)
    response = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
        output_config={
            "format": {"type": "json_schema", "schema": _FINDING_LABEL_REQUEST_SCHEMA}
        },
    )
    text = next(block.text for block in response.content if block.type == "text")
    parsed = json.loads(text)
    return {row["transaction_id"]: row["finding_summary"] for row in parsed["rows"]}


def run_workpaper_agent(
    decision_transactions: list[dict],
    evidence_transactions: list[dict] | None = None,
    assumed_minutes_per_item: float = DEFAULT_ASSUMED_MINUTES_PER_ITEM,
    client: anthropic.Anthropic | None = None,
) -> dict:
    """Compile a case's Decision Agent outputs into the final workpaper.

    decision_transactions: every run_decision_agent() output for one case
    (one per transaction; this benchmark always has exactly one).
    evidence_transactions: the matching run_evidence_agent() outputs, used
    only to source document IDs for clean (findings-free) rows - see module
    docstring for why Decision's output alone isn't enough for those.
    assumed_minutes_per_item: the configurable minutes-saved-per-auto-clear
    assumption the spec requires be stated explicitly in the output.

    Returns a dict matching the Workpaper Agent output schema from
    docs/agent-spec.md section 5.
    """
    if not decision_transactions:
        raise ValueError(
            "decision_transactions is empty - nothing to compile into a workpaper"
        )

    case_ids = {t["case_id"] for t in decision_transactions}
    if len(case_ids) != 1:
        raise ValueError(
            f"decision_transactions must all share one case_id, got {sorted(case_ids)}"
        )
    case_id = case_ids.pop()

    evidence_by_transaction_id = {
        t["transaction_id"]: t for t in (evidence_transactions or [])
    }

    rows: list[dict] = []
    row_transaction_ids: list[str] = []
    row_findings: list[list[dict]] = []
    transactions_needing_labels: list[dict] = []

    for decision in decision_transactions:
        transaction_id = decision["transaction_id"]
        findings = decision["findings"]

        if findings:
            evidence_docs = _union_finding_documents(findings)
            transactions_needing_labels.append(decision)
        else:
            evidence_transaction = evidence_by_transaction_id.get(transaction_id)
            evidence_docs = list(evidence_transaction["documents"]) if evidence_transaction else []

        rows.append(
            {
                "document": evidence_docs[0] if evidence_docs else None,
                "finding": None,  # filled in below, once labels are known
                "evidence": evidence_docs,
                "confidence": decision["confidence"],
                "action": decision["action"],
            }
        )
        row_transaction_ids.append(transaction_id)
        row_findings.append(findings)

    finding_labels = (
        _generate_finding_labels(transactions_needing_labels, client=client)
        if transactions_needing_labels
        else {}
    )

    for row, transaction_id, findings in zip(rows, row_transaction_ids, row_findings):
        row["finding"] = finding_labels.get(transaction_id, "Clean") if findings else "Clean"

    items_reviewed = len(decision_transactions)
    auto_cleared = sum(1 for t in decision_transactions if t["action"] == "auto_clear")
    human_review = sum(1 for t in decision_transactions if t["action"] == "human_review")
    critical = sum(
        1
        for t in decision_transactions
        if any(f["severity"] == "high" for f in t["findings"])
    )
    estimated_minutes_saved = auto_cleared * assumed_minutes_per_item

    return {
        "case_id": case_id,
        "rows": rows,
        "summary": {
            "items_reviewed": items_reviewed,
            "auto_cleared": auto_cleared,
            "human_review": human_review,
            "critical": critical,
            "assumed_minutes_per_item": assumed_minutes_per_item,
            "estimated_minutes_saved": estimated_minutes_saved,
        },
    }


def run_full_pipeline(
    case_folder: str,
    assumed_minutes_per_item: float = DEFAULT_ASSUMED_MINUTES_PER_ITEM,
    intake_client: anthropic.Anthropic | None = None,
    evidence_client: anthropic.Anthropic | None = None,
    anomaly_client: anthropic.Anthropic | None = None,
    decision_client: anthropic.Anthropic | None = None,
    workpaper_client: anthropic.Anthropic | None = None,
) -> dict:
    """Convenience: Intake -> Evidence -> Anomaly -> Decision -> Workpaper
    for one case folder (this benchmark's one-transaction-per-case shape)."""
    intake_documents = run_intake_agent(case_folder, client=intake_client)
    evidence_transaction = run_evidence_agent(intake_documents, client=evidence_client)
    anomaly_transaction = run_anomaly_agent(
        evidence_transaction, intake_documents, client=anomaly_client
    )
    decision_transaction = run_decision_agent(anomaly_transaction, client=decision_client)
    return run_workpaper_agent(
        [decision_transaction],
        [evidence_transaction],
        assumed_minutes_per_item=assumed_minutes_per_item,
        client=workpaper_client,
    )


if __name__ == "__main__":
    targets = sys.argv[1:] if len(sys.argv) > 1 else ["dataset/CASE_01/", "dataset/CASE_04/"]

    for target in targets:
        print(f"=== {target} ===")
        result = run_full_pipeline(target)
        print(json.dumps(result, indent=2))
        print()
