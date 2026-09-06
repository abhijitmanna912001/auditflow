"""Anomaly Agent for AuditFlow.

Implements docs/agent-spec.md section 3: checks a transaction's evidence map
against a fixed, bounded set of issue types.

The spec's declared input is "Evidence Agent's transaction evidence maps",
but that output schema (transaction_id, case_id, documents as a list of IDs,
missing_evidence, evidence_confidence, notes) carries no field-level data -
detecting vendor_mismatch, amount_mismatch, date_inconsistency, or
duplicate_invoice requires comparing the actual vendor/amount/date values
across documents, which only exist in the Intake Agent's records. So
run_anomaly_agent() takes both: the Evidence Agent's transaction map (what
the spec names as input) and the underlying Intake Agent document records
for that transaction's documents (what the map's document IDs point to).

Usage:
    python3 agents/anomaly_agent.py dataset/CASE_01/ dataset/CASE_04/
"""

from __future__ import annotations

import json
import sys

from observability import configure_neatlogs

configure_neatlogs()

import anthropic

from evidence_agent import run_evidence_agent
from intake_agent import run_intake_agent

MODEL = "claude-sonnet-5"

# Copied verbatim from docs/agent-spec.md section 3 ("System prompt:").
SYSTEM_PROMPT = (
    "You are the Anomaly Agent for AuditFlow. You receive transaction "
    "evidence maps from the Evidence Agent. For each transaction, check for "
    "exactly these issue types only: duplicate_invoice, amount_mismatch, "
    "missing_po, missing_receipt, vendor_mismatch, date_inconsistency. Do "
    "not invent other categories. missing_po and missing_receipt apply only "
    "when no purchase order or receipt document exists at all for the "
    "transaction - if one exists but conflicts with another document on "
    "vendor, amount, or date, score that conflict under amount_mismatch, "
    "vendor_mismatch, or date_inconsistency only, never additionally as "
    "missing_po/missing_receipt for the same fact. For each issue found, "
    "output: type, the documents involved, a severity (low/medium/high), a "
    "confidence score (0-1), and a one-sentence explanation. A transaction "
    "can have zero, one, or multiple findings. If no issues are found, "
    "output an empty findings list - do not force a finding."
)

# findings[].type is one of these six - no other categories.
FINDING_TYPES = [
    "duplicate_invoice",
    "amount_mismatch",
    "missing_po",
    "missing_receipt",
    "vendor_mismatch",
    "date_inconsistency",
]

SEVERITY_LEVELS = ["low", "medium", "high"]

_FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": FINDING_TYPES},
        "documents": {"type": "array", "items": {"type": "string"}},
        "severity": {"type": "string", "enum": SEVERITY_LEVELS},
        "confidence": {"type": "number"},
        "explanation": {"type": "string"},
    },
    "required": ["type", "documents", "severity", "confidence", "explanation"],
    "additionalProperties": False,
}

# One object per transaction, per the Anomaly Agent output schema in the
# spec: transaction_id, case_id, findings (may be empty).
_TRANSACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "transaction_id": {"type": "string"},
        "case_id": {"type": "string"},
        "findings": {"type": "array", "items": _FINDING_SCHEMA},
    },
    "required": ["transaction_id", "case_id", "findings"],
    "additionalProperties": False,
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"transactions": {"type": "array", "items": _TRANSACTION_SCHEMA}},
    "required": ["transactions"],
    "additionalProperties": False,
}


def _build_user_message(evidence_transaction: dict, intake_documents: list[dict]) -> str:
    doc_ids = set(evidence_transaction["documents"])
    relevant_docs = [doc for doc in intake_documents if doc["doc_id"] in doc_ids]

    return (
        f"Case ID: {evidence_transaction['case_id']}\n"
        f"Transaction ID: {evidence_transaction['transaction_id']}\n\n"
        "Evidence Agent's transaction evidence map:\n"
        f"{json.dumps(evidence_transaction, indent=2)}\n\n"
        "Underlying Intake Agent document records for every document listed "
        "in that evidence map (the evidence map only tracks which documents "
        "are present or missing, not their field values - use these "
        "vendor/amount/currency/date fields to actually check for the issue "
        "types below):\n"
        f"{json.dumps(relevant_docs, indent=2)}"
    )


def run_anomaly_agent(
    evidence_transaction: dict,
    intake_documents: list[dict],
    client: anthropic.Anthropic | None = None,
) -> dict:
    """Run the Anomaly Agent against one transaction's evidence map.

    evidence_transaction: one transaction dict from run_evidence_agent().
    intake_documents: the Intake Agent's document records for the same case
    (see module docstring for why both are needed).

    Returns a single transaction dict matching the Anomaly Agent output
    schema from docs/agent-spec.md section 3.
    """
    case_id = evidence_transaction["case_id"]
    transaction_id = evidence_transaction["transaction_id"]

    other_cases = {doc["case_id"] for doc in intake_documents} - {case_id}
    if other_cases:
        raise ValueError(
            f"intake_documents contains documents from a different case_id: "
            f"{sorted(other_cases)} (expected only {case_id!r})"
        )

    user_message = _build_user_message(evidence_transaction, intake_documents)

    client = client or anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )

    text = next(block.text for block in response.content if block.type == "text")
    parsed = json.loads(text)
    transactions = parsed["transactions"]

    if len(transactions) != 1:
        raise ValueError(
            f"Expected exactly one transaction for {case_id} (this benchmark is "
            f"one transaction per case), got {len(transactions)}"
        )

    transaction = transactions[0]
    # transaction_id/case_id are deterministic join keys used across every
    # downstream agent and by evaluation/evaluate.py - enforce the values we
    # already know rather than trust the model's echo of them.
    transaction["case_id"] = case_id
    transaction["transaction_id"] = transaction_id

    return transaction


def run_intake_evidence_anomaly(
    case_folder: str,
    intake_client: anthropic.Anthropic | None = None,
    evidence_client: anthropic.Anthropic | None = None,
    anomaly_client: anthropic.Anthropic | None = None,
) -> dict:
    """Convenience: Intake Agent -> Evidence Agent -> Anomaly Agent for one case."""
    intake_documents = run_intake_agent(case_folder, client=intake_client)
    evidence_transaction = run_evidence_agent(intake_documents, client=evidence_client)
    return run_anomaly_agent(evidence_transaction, intake_documents, client=anomaly_client)


if __name__ == "__main__":
    targets = sys.argv[1:] if len(sys.argv) > 1 else ["dataset/CASE_01/", "dataset/CASE_04/"]

    for target in targets:
        print(f"=== {target} ===")
        result = run_intake_evidence_anomaly(target)
        print(json.dumps(result, indent=2))
        print()
