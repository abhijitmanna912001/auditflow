"""Evidence Agent for AuditFlow.

Implements docs/agent-spec.md section 2: takes the Intake Agent's structured
output for a case and groups documents into transactions by shared
references, determining which expected supporting documents are present or
missing and how well-supported each transaction is.

This benchmark uses exactly one transaction per case (see the "Ground truth
format" section of the spec), so run_evidence_agent() always returns a
single transaction object, with transaction_id derived from case_id the same
deterministic way the ground truth does (CASE_04 -> TXN_04).

Usage:
    python3 agents/evidence_agent.py dataset/CASE_01/ dataset/CASE_05/
"""

from __future__ import annotations

import json
import re
import sys

from observability import configure_neatlogs

configure_neatlogs()

import anthropic

from intake_agent import run_intake_agent

MODEL = "claude-sonnet-5"

# Copied verbatim from docs/agent-spec.md section 2 ("System prompt:").
SYSTEM_PROMPT = (
    "You are the Evidence Agent for AuditFlow. You receive structured documents "
    "from the Intake Agent for one case. Group documents into transactions based "
    "on shared references (e.g., an invoice and its PO). For each transaction, "
    "determine: which documents are present, which expected supporting "
    "documents are missing (e.g., an invoice with no matching bank "
    "transaction), and an evidence_confidence score (0-1) reflecting how "
    "well-supported the transaction is. If a document type is missing, check "
    "whether that's expected (e.g., some vendors are PO-exempt - infer this "
    "only from patterns in the provided documents, never assume). Output one "
    "JSON object per transaction following the schema above."
)

# One object per transaction, per the Evidence Agent output schema in the
# spec: transaction_id, case_id, documents, missing_evidence,
# evidence_confidence, notes
_TRANSACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "transaction_id": {"type": "string"},
        "case_id": {"type": "string"},
        "documents": {"type": "array", "items": {"type": "string"}},
        "missing_evidence": {"type": "array", "items": {"type": "string"}},
        "evidence_confidence": {"type": "number"},
        "notes": {"type": "string"},
    },
    "required": [
        "transaction_id",
        "case_id",
        "documents",
        "missing_evidence",
        "evidence_confidence",
        "notes",
    ],
    "additionalProperties": False,
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"transactions": {"type": "array", "items": _TRANSACTION_SCHEMA}},
    "required": ["transactions"],
    "additionalProperties": False,
}

_CASE_ID_PATTERN = re.compile(r"CASE_(\d+)")


def _derive_transaction_id(case_id: str) -> str:
    """CASE_04 -> TXN_04, the deterministic mapping docs/agent-spec.md defines."""
    match = _CASE_ID_PATTERN.fullmatch(case_id)
    if not match:
        raise ValueError(
            f"case_id {case_id!r} doesn't match the expected CASE_<number> format"
        )
    return f"TXN_{match.group(1)}"


def _build_user_message(case_id: str, transaction_id: str, documents: list[dict]) -> str:
    return (
        f"Case ID: {case_id}\n"
        f"This benchmark case is exactly one transaction; its transaction_id "
        f"is {transaction_id}. Group every document below into that one "
        "transaction, then determine which documents are present, which "
        "expected supporting documents are missing, and how well-supported "
        "the transaction is.\n\n"
        "Intake Agent output for every document in this case:\n"
        f"{json.dumps(documents, indent=2)}"
    )


def run_evidence_agent(
    intake_documents: list[dict], client: anthropic.Anthropic | None = None
) -> dict:
    """Run the Evidence Agent against one case's Intake Agent output.

    intake_documents: the list of document dicts produced by
    run_intake_agent() for a single case (all must share one case_id).

    Returns a single transaction dict matching the Evidence Agent output
    schema from docs/agent-spec.md section 2.
    """
    if not intake_documents:
        raise ValueError("intake_documents is empty - nothing to group into a transaction")

    case_ids = {doc["case_id"] for doc in intake_documents}
    if len(case_ids) != 1:
        raise ValueError(
            f"intake_documents must all share one case_id, got {sorted(case_ids)}"
        )
    case_id = case_ids.pop()
    transaction_id = _derive_transaction_id(case_id)

    user_message = _build_user_message(case_id, transaction_id, intake_documents)

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


def run_intake_and_evidence(
    case_folder: str,
    intake_client: anthropic.Anthropic | None = None,
    evidence_client: anthropic.Anthropic | None = None,
) -> dict:
    """Convenience: Intake Agent -> Evidence Agent for one case folder."""
    intake_documents = run_intake_agent(case_folder, client=intake_client)
    return run_evidence_agent(intake_documents, client=evidence_client)


if __name__ == "__main__":
    targets = sys.argv[1:] if len(sys.argv) > 1 else ["dataset/CASE_01/", "dataset/CASE_05/"]

    for target in targets:
        print(f"=== {target} ===")
        result = run_intake_and_evidence(target)
        print(json.dumps(result, indent=2))
        print()
