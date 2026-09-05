"""Decision Agent for AuditFlow.

Implements docs/agent-spec.md section 4: decides auto_clear vs
human_review for a transaction based on whether its Anomaly Agent findings
list is empty or not, and reports the finding confidence for context.

Decision rule (see docs/agent-spec.md section 4 for the full rationale):
findings empty -> auto_clear; findings non-empty (any finding at all,
regardless of type, severity, or confidence) -> human_review. This is
computed deterministically in code, not left to the model - it's a fixed,
mechanical rule, and an audit pipeline shouldn't have a decision an LLM
could get wrong or apply inconsistently between runs. An earlier version of
this rule instead gated on whether confidence crossed 0.95/0.80; that
caused obvious, high-severity findings (which the Anomaly Agent rates with
*high* confidence precisely because they're so clear-cut) to auto-clear -
the opposite of intended. Ground truth confirmed the corrected rule: every
one of this benchmark's 12 cases with any expected_findings expects
human_review, regardless of finding type or severity.

confidence and thresholds_used are still computed/echoed for context (the
reason field, downstream display), but no longer gate the action - see the
module-level AUTO_CLEAR_THRESHOLD/HUMAN_REVIEW_THRESHOLD constants, which
are informational only now. The Anthropic API is still called, with the
system prompt copied verbatim, to write the plain-language `reason` field
the spec asks for: the one part of this agent's job that actually requires
judgment/natural language generation rather than arithmetic. Every other
output field (action, confidence, thresholds_used, findings) is
computed/carried forward in code and is not something the model can alter.

Per section 4's example and section 5's "(type, documents, severity,
explanation)" description of what Workpaper receives, findings carried
forward here drop the per-finding `confidence` field the Anomaly Agent
produced - the Decision Agent already surfaces a single confidence value
(of the highest-severity finding) at the top level.

Usage:
    python3 agents/decision_agent.py dataset/CASE_01/ dataset/CASE_04/
"""

from __future__ import annotations

import json
import sys

import anthropic

from anomaly_agent import run_intake_evidence_anomaly

MODEL = "claude-opus-5"

# Copied verbatim from docs/agent-spec.md section 4 ("System prompt:").
SYSTEM_PROMPT = (
    "You are the Decision Agent for AuditFlow. You receive anomaly findings "
    "per transaction. If the findings list is empty, the action is "
    "auto_clear. If the findings list is non-empty - any finding at all, "
    "regardless of its type, severity, or confidence - the action is "
    "human_review. Still compute a confidence value as the confidence score "
    "of the highest-severity finding (or 1.0 if no findings) and include it "
    "in the output for context, and echo the thresholds used (auto_clear: "
    "0.95, human_review: 0.80) as reference values - but do not use either "
    "one to decide the action; presence of findings alone determines "
    "auto_clear vs human_review. Always output a reason field explaining "
    "the decision in plain language referencing the actual finding (or "
    "noting the transaction was clean). Carry the full findings list "
    "forward unchanged from your input into your output (empty list if "
    "none) - you decide the action, you do not drop or summarize the "
    "findings data, since the next agent needs it."
)

ACTIONS = ["auto_clear", "human_review"]

# Informational only as of the corrected decision rule (see module
# docstring) - echoed in thresholds_used for context, but no longer used to
# decide the action. The action is decided solely by whether findings is
# empty (see _decide_action).
AUTO_CLEAR_THRESHOLD = 0.95
HUMAN_REVIEW_THRESHOLD = 0.80

_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}

_CARRIED_FORWARD_FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string"},
        "documents": {"type": "array", "items": {"type": "string"}},
        "severity": {"type": "string", "enum": ["low", "medium", "high"]},
        "explanation": {"type": "string"},
    },
    "required": ["type", "documents", "severity", "explanation"],
    "additionalProperties": False,
}

_THRESHOLDS_USED_SCHEMA = {
    "type": "object",
    "properties": {
        "auto_clear": {"type": "number"},
        "human_review": {"type": "number"},
    },
    "required": ["auto_clear", "human_review"],
    "additionalProperties": False,
}

# Full Decision Agent output shape for one transaction, per the spec - used
# to document/validate the final returned dict, not sent to the model as-is
# (see _REASON_REQUEST_SCHEMA below).
TRANSACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "transaction_id": {"type": "string"},
        "case_id": {"type": "string"},
        "action": {"type": "string", "enum": ACTIONS},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
        "thresholds_used": _THRESHOLDS_USED_SCHEMA,
        "findings": {"type": "array", "items": _CARRIED_FORWARD_FINDING_SCHEMA},
    },
    "required": [
        "transaction_id",
        "case_id",
        "action",
        "confidence",
        "reason",
        "thresholds_used",
        "findings",
    ],
    "additionalProperties": False,
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"transactions": {"type": "array", "items": TRANSACTION_SCHEMA}},
    "required": ["transactions"],
    "additionalProperties": False,
}

# Schema actually requested from the model: every field except `reason` is
# computed deterministically in code (see module docstring), so the API
# call only asks for that one field.
_REASON_SCHEMA = {
    "type": "object",
    "properties": {"reason": {"type": "string"}},
    "required": ["reason"],
    "additionalProperties": False,
}
_REASON_REQUEST_SCHEMA = {
    "type": "object",
    "properties": {"transactions": {"type": "array", "items": _REASON_SCHEMA}},
    "required": ["transactions"],
    "additionalProperties": False,
}


def _confidence_of_highest_severity_finding(findings: list[dict]) -> float:
    """Per the spec: confidence of the highest-severity finding, or 1.0 if none.

    When multiple findings tie for the highest severity, the spec doesn't
    define a tie-break; the lowest of their confidences is used, since that's
    the more conservative choice (pushing toward human_review rather than
    auto_clear) for an audit pipeline.
    """
    if not findings:
        return 1.0
    max_rank = max(_SEVERITY_RANK[f["severity"]] for f in findings)
    tied_confidences = [
        f["confidence"] for f in findings if _SEVERITY_RANK[f["severity"]] == max_rank
    ]
    return min(tied_confidences)


def _decide_action(findings: list[dict]) -> str:
    """Per the corrected rule: any finding at all -> human_review; none -> auto_clear."""
    return "human_review" if findings else "auto_clear"


def _carry_forward_finding(finding: dict) -> dict:
    return {
        "type": finding["type"],
        "documents": finding["documents"],
        "severity": finding["severity"],
        "explanation": finding["explanation"],
    }


def _build_user_message(
    case_id: str,
    transaction_id: str,
    findings: list[dict],
    action: str,
    confidence: float,
    thresholds_used: dict,
) -> str:
    return (
        f"Case ID: {case_id}\n"
        f"Transaction ID: {transaction_id}\n\n"
        "Anomaly Agent findings for this transaction:\n"
        f"{json.dumps(findings, indent=2)}\n\n"
        "The action below has already been decided deterministically - "
        "human_review if findings is non-empty, auto_clear if it's empty - "
        "regardless of confidence. confidence and thresholds_used are "
        "computed/echoed for context only and do not affect the action. Do "
        "not recompute, second-guess, or contradict any of these values. "
        "Your only job is to write the reason field: a one-to-two sentence, "
        "plain-language explanation of this decision that references the "
        "actual finding(s) involved (or says the transaction was clean, if "
        "there are none).\n"
        f"action: {action}\n"
        "confidence (of the highest-severity finding, or 1.0 if none - "
        f"context only, does not determine the action): {confidence}\n"
        f"thresholds_used (reference values only): {json.dumps(thresholds_used)}\n"
    )


def run_decision_agent(
    anomaly_transaction: dict, client: anthropic.Anthropic | None = None
) -> dict:
    """Run the Decision Agent against one transaction's Anomaly Agent output.

    anomaly_transaction: one transaction dict from run_anomaly_agent().

    Returns a single transaction dict matching the Decision Agent output
    schema from docs/agent-spec.md section 4.
    """
    case_id = anomaly_transaction["case_id"]
    transaction_id = anomaly_transaction["transaction_id"]
    findings = anomaly_transaction["findings"]

    confidence = _confidence_of_highest_severity_finding(findings)
    action = _decide_action(findings)
    thresholds_used = {
        "auto_clear": AUTO_CLEAR_THRESHOLD,
        "human_review": HUMAN_REVIEW_THRESHOLD,
    }
    carried_findings = [_carry_forward_finding(f) for f in findings]

    user_message = _build_user_message(
        case_id, transaction_id, findings, action, confidence, thresholds_used
    )

    client = client or anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
        output_config={"format": {"type": "json_schema", "schema": _REASON_REQUEST_SCHEMA}},
    )

    text = next(block.text for block in response.content if block.type == "text")
    parsed = json.loads(text)
    reason_entries = parsed["transactions"]

    if len(reason_entries) != 1:
        raise ValueError(
            f"Expected exactly one transaction for {case_id} (this benchmark is "
            f"one transaction per case), got {len(reason_entries)}"
        )

    return {
        "transaction_id": transaction_id,
        "case_id": case_id,
        "action": action,
        "confidence": confidence,
        "reason": reason_entries[0]["reason"],
        "thresholds_used": thresholds_used,
        "findings": carried_findings,
    }


def run_intake_evidence_anomaly_decision(
    case_folder: str,
    intake_client: anthropic.Anthropic | None = None,
    evidence_client: anthropic.Anthropic | None = None,
    anomaly_client: anthropic.Anthropic | None = None,
    decision_client: anthropic.Anthropic | None = None,
) -> dict:
    """Convenience: Intake -> Evidence -> Anomaly -> Decision for one case."""
    anomaly_transaction = run_intake_evidence_anomaly(
        case_folder,
        intake_client=intake_client,
        evidence_client=evidence_client,
        anomaly_client=anomaly_client,
    )
    return run_decision_agent(anomaly_transaction, client=decision_client)


if __name__ == "__main__":
    targets = sys.argv[1:] if len(sys.argv) > 1 else ["dataset/CASE_01/", "dataset/CASE_04/"]

    for target in targets:
        print(f"=== {target} ===")
        result = run_intake_evidence_anomaly_decision(target)
        print(json.dumps(result, indent=2))
        print()
