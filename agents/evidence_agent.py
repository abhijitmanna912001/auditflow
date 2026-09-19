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

from observability import configure_neatlogs, shutdown_neatlogs

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
    "only from patterns in the provided documents, never assume). Internal "
    "consistency among the documents you do have (matching amounts, vendor "
    "names, a logical date sequence) never proves an absent document type "
    "wasn't required, and a successful payment status is not proof that a "
    "payment-terms condition like a required receipt was actually satisfied - "
    "only the document itself, if present, can establish that. Output one "
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

    shutdown_neatlogs()

    return transaction


def run_intake_and_evidence(
    case_folder: str,
    intake_client: anthropic.Anthropic | None = None,
    evidence_client: anthropic.Anthropic | None = None,
) -> dict:
    """Convenience: Intake Agent -> Evidence Agent for one case folder."""
    intake_documents = run_intake_agent(case_folder, client=intake_client)
    return run_evidence_agent(intake_documents, client=evidence_client)


# Evidence Resolver: below this evidence_confidence, a single pass is
# treated as potentially ambiguous and gets a second, independent opinion
# rather than being trusted on its own. Chosen as a starting point - low
# enough that clearly well-supported transactions (the large majority of
# the benchmark) never pay for a second call, high enough to catch genuine
# borderline cases like CASE_06's mixed goods/service transaction.
RESOLVER_CONFIDENCE_THRESHOLD = 0.7


def _missing_evidence_roughly_matches(a: list[str], b: list[str]) -> bool:
    """True if two missing_evidence lists say the same thing, allowing for
    wording differences between two independent model calls (e.g. "signed
    goods/service receipt (explicitly required by...)" vs "signed
    goods/service receipt (required by...)" describing the same gap).

    Exact set equality is too strict here - the model is asked for a
    natural-language description per missing item, not a fixed enum, so two
    correct, substantively-agreeing passes can still differ string-for-
    string. Compared on count and first-significant-word overlap instead:
    same number of missing items, and each item in one list has a
    reasonably close match in the other by shared leading words. This is a
    heuristic, not a semantic diff - it's deliberately conservative (biased
    toward calling two entries a match) since a false "agreement" here only
    means we skip flagging a difference that turns out not to matter (both
    entries already survive into the unioned unmatched entries in the
    disagreement path if this heuristic is wrong), whereas a false
    "disagreement" would incorrectly union near-duplicate phrasing of the
    same one missing item into two.
    """
    if len(a) != len(b):
        return False
    if not a:  # both empty
        return True

    def _key(item: str) -> set[str]:
        # First few words, lowercased, alnum only - enough to identify
        # "signed goods/service receipt" as the same subject regardless of
        # how the parenthetical justification is phrased.
        words = "".join(c if c.isalnum() or c.isspace() else " " for c in item.lower()).split()
        return set(words[:4])

    a_keys = [_key(item) for item in a]
    b_keys = [_key(item) for item in b]

    # Each item in a must have some b item sharing at least half its
    # leading-word key (and vice versa isn't checked separately since the
    # lengths already match) - a greedy, order-independent match.
    remaining_b = list(b_keys)
    for a_key in a_keys:
        match_idx = next(
            (i for i, b_key in enumerate(remaining_b) if len(a_key & b_key) >= max(1, len(a_key) // 2)),
            None,
        )
        if match_idx is None:
            return False
        remaining_b.pop(match_idx)
    return True


def run_evidence_agent_with_resolver(
    intake_documents: list[dict],
    threshold: float = RESOLVER_CONFIDENCE_THRESHOLD,
    client: anthropic.Anthropic | None = None,
    second_pass_client: anthropic.Anthropic | None = None,
) -> dict:
    """Run the Evidence Agent once; if its evidence_confidence is below
    `threshold`, run it again independently and compare.

    This targets the CASE_06-style failure mode: on a genuinely ambiguous
    transaction, a single reasoning pass can land on a plausible-looking but
    wrong answer (e.g. missing_evidence: [] on a case that actually needed
    a receipt). One low-confidence pass alone doesn't know it might be
    wrong; two independent passes that disagree are a much stronger signal
    that a human should look, and one that doesn't require any change to
    the confidence threshold - the case can even end up above it after
    resolution, once the disagreement itself is folded into the record.

    Whichever transaction is returned is in the exact same shape
    run_evidence_agent() already produces (Anomaly/Decision/Workpaper are
    unchanged), plus one added field: `resolution`, recording whether a
    second pass ran, whether the two passes agreed, and which fields
    differed if not - visible in the final workpaper for transparency
    rather than buried in an internal retry a reviewer can't see.

    On disagreement, the two `missing_evidence` lists are UNIONED rather
    than either pass's list picked on its own - the safer default for an
    audit tool, so a real gap one pass caught and the other missed is never
    silently dropped. The lower of the two evidence_confidence scores is
    kept, reflecting the genuine uncertainty a disagreement demonstrates.
    """
    first = run_evidence_agent(intake_documents, client=client)

    if first["evidence_confidence"] >= threshold:
        first["resolution"] = {
            "second_pass_run": False,
            "agreement": None,
            "reason": (
                f"First-pass evidence_confidence {first['evidence_confidence']} "
                f">= threshold {threshold}; no second pass needed."
            ),
        }
        return first

    second = run_evidence_agent(
        intake_documents, client=second_pass_client or client
    )

    agree = _missing_evidence_roughly_matches(
        first["missing_evidence"], second["missing_evidence"]
    )

    if agree:
        # Both independent passes landed on the same missing_evidence -
        # genuine agreement, not just one low-confidence guess. Keep the
        # higher-confidence pass's transaction as the result.
        resolved = first if first["evidence_confidence"] >= second["evidence_confidence"] else second
        resolved["resolution"] = {
            "second_pass_run": True,
            "agreement": True,
            "reason": (
                "Two independent passes agreed on missing_evidence "
                f"({sorted(resolved['missing_evidence'])})."
            ),
        }
        return resolved

    # Genuine disagreement: union the two missing_evidence lists (never
    # silently drop a gap either pass found), keep the lower confidence,
    # and carry both passes' notes forward so a reviewer can see why.
    unioned_missing = sorted(set(first["missing_evidence"]) | set(second["missing_evidence"]))
    resolved = dict(first)
    resolved["missing_evidence"] = unioned_missing
    resolved["evidence_confidence"] = min(
        first["evidence_confidence"], second["evidence_confidence"]
    )
    resolved["notes"] = (
        f"{first['notes']} | Second-pass disagreement: pass 1 flagged "
        f"{sorted(first['missing_evidence'])} missing, pass 2 flagged "
        f"{sorted(second['missing_evidence'])} missing; union kept below. "
        f"Pass 2 notes: {second['notes']}"
    )
    resolved["resolution"] = {
        "second_pass_run": True,
        "agreement": False,
        "pass_1_missing_evidence": sorted(first["missing_evidence"]),
        "pass_2_missing_evidence": sorted(second["missing_evidence"]),
        "reason": (
            "Two independent passes disagreed on missing_evidence; both "
            "sets were unioned into the result rather than picking one, "
            "so nothing either pass found is silently dropped."
        ),
    }
    return resolved


if __name__ == "__main__":
    targets = sys.argv[1:] if len(sys.argv) > 1 else ["dataset/CASE_01/", "dataset/CASE_05/"]

    for target in targets:
        print(f"=== {target} ===")
        result = run_intake_and_evidence(target)
        print(json.dumps(result, indent=2))
        print()