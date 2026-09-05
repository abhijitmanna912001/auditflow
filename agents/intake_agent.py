"""Intake Agent for AuditFlow.

Implements docs/agent-spec.md section 1: reads the raw financial documents in a
case folder and asks Claude to classify each one and extract its structured
fields.

Usage:
    python3 agents/intake_agent.py dataset/CASE_01/
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import anthropic
import neatlogs

# Tracing is opt-in via env var so no secret is ever committed to this
# public repo - set NEATLOGS_API_KEY to enable. instrument_all() (called
# inside neatlogs.init()) auto-patches any already-imported provider SDK
# found in SUPPORTED_PROVIDERS (which includes "anthropic"), so this runs
# before any Anthropic API call regardless of import order.
_NEATLOGS_API_KEY = os.environ.get("NEATLOGS_API_KEY")
if _NEATLOGS_API_KEY:
    neatlogs.init(
        api_key=_NEATLOGS_API_KEY,
        tags=["agent:intake", "project:auditflow"],
    )


def _flush_neatlogs() -> None:
    """Block until any in-flight Neatlogs trace uploads finish.

    neatlogs 1.1.8 has no public flush() function - each span is POSTed to
    the Neatlogs backend on a background thread as soon as it completes
    (LLMTracker.log_llm_call -> _send_data_to_server), not buffered for a
    later flush. LLMTracker.shutdown() (the same call neatlogs' own
    atexit hook makes) is what actually blocks until those in-flight
    sends finish, so it's the real equivalent of "flush" here.
    """
    tracker = neatlogs.get_tracker()
    if tracker is not None:
        tracker.shutdown()


MODEL = "claude-opus-5"

# Copied verbatim from docs/agent-spec.md section 1 ("System prompt:").
SYSTEM_PROMPT = (
    "You are the Intake Agent for AuditFlow. You receive raw financial documents "
    "(invoices, receipts, purchase orders, bank statements, ledger entries) for one "
    "audit case. For each document, extract: document ID, document type, vendor "
    "name, amount, currency, date, and any reference IDs to other documents (e.g., "
    "a PO number cited on an invoice). Output one JSON object per document "
    "following the schema above. If a field cannot be determined, set it to null "
    "and note why in an extraction_notes field. Do not guess amounts or dates - "
    "flag uncertainty rather than fabricate."
)

# type is one of: invoice, receipt, purchase_order, bank_statement, ledger_entry
DOCUMENT_TYPES = ["invoice", "receipt", "purchase_order", "bank_statement", "ledger_entry"]

# One object per document, per the Intake Agent output schema in the spec:
# doc_id, type, vendor, amount, currency, date, references, case_id, extraction_notes
_DOCUMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "doc_id": {"type": "string"},
        "type": {"type": "string", "enum": DOCUMENT_TYPES},
        "vendor": {"type": ["string", "null"]},
        "amount": {"type": ["number", "null"]},
        "currency": {"type": ["string", "null"]},
        "date": {"type": ["string", "null"]},
        "references": {"type": "array", "items": {"type": "string"}},
        "case_id": {"type": "string"},
        "extraction_notes": {"type": ["string", "null"]},
    },
    "required": [
        "doc_id",
        "type",
        "vendor",
        "amount",
        "currency",
        "date",
        "references",
        "case_id",
        "extraction_notes",
    ],
    "additionalProperties": False,
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"documents": {"type": "array", "items": _DOCUMENT_SCHEMA}},
    "required": ["documents"],
    "additionalProperties": False,
}


def _read_case_documents(case_path: Path) -> list[tuple[str, str]]:
    """Read every .txt fixture in a case folder, sorted for determinism."""
    if not case_path.is_dir():
        raise FileNotFoundError(f"Case folder not found: {case_path}")

    files = sorted(case_path.glob("*.txt"))
    if not files:
        raise FileNotFoundError(f"No .txt documents found in {case_path}")

    return [(f.name, f.read_text()) for f in files]


def _build_user_message(case_id: str, documents: list[tuple[str, str]]) -> str:
    parts = [
        f"Case ID: {case_id}\n"
        f"The following {len(documents)} document(s) belong to this audit case. "
        "Each is introduced by its source filename for reference, but extract "
        "doc_id and every other field from the document's own content, not the "
        "filename. Classify and extract fields for every document listed.\n"
    ]
    for filename, content in documents:
        parts.append(f"--- Source file: {filename} ---\n{content}")
    return "\n\n".join(parts)


def run_intake_agent(
    case_folder: str, client: anthropic.Anthropic | None = None
) -> list[dict]:
    """Run the Intake Agent against every document in a case folder.

    Returns one dict per document matching the Intake Agent output schema
    from docs/agent-spec.md section 1.
    """
    case_path = Path(case_folder)
    case_id = case_path.name  # e.g. dataset/CASE_04/ -> "CASE_04"

    documents = _read_case_documents(case_path)
    user_message = _build_user_message(case_id, documents)

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

    _flush_neatlogs()

    return parsed["documents"]


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "dataset/CASE_01/"
    results = run_intake_agent(target)
    print(json.dumps(results, indent=2))
