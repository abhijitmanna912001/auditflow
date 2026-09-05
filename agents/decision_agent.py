"""Decision Agent for AuditFlow.

Implements docs/agent-spec.md section 4: applies fixed confidence
thresholds to a transaction's Anomaly Agent findings to decide auto_clear
vs human_review.

The threshold logic (confidence >= 0.95 -> auto_clear; confidence < 0.80 ->
human_review; 0.80-0.95 -> human_review, borderline) is computed
deterministically in code from the Anomaly Agent's findings, not left to
the model. It's a fixed, mechanical rule - the system prompt itself says
"Never silently override the threshold logic" - and an audit pipeline
should not have a stochastic auto_clear/human_review boundary that an LLM
might round differently between runs. The Anthropic API is still called,
with the system prompt copied verbatim, to write the plain-language
`reason` field the spec asks for: the one part of this agent's job that
actually requires judgment/natural language generation rather than
arithmetic. Every other output field (action, confidence, thresholds_used,
findings) is computed/carried forward in code and is not something the
model can alter.

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
    "per transaction. Using the confidence score of the highest-severity "
    "finding (or 1.0 if no findings), apply these thresholds: confidence "
    ">= 0.95 -> action auto_clear. confidence < 0.80 -> action human_review. "
    "Between 0.80 and 0.95 -> action human_review but flagged as borderline. "
    "Always output a reason field explaining the decision in plain language "
    "referencing the actual finding, and echo the thresholds used. Carry "
    "the full findings list forward unchanged from your input into your "
    "output (empty list if none) - you decide the action, you do not drop "
    "or summarize the findings data, since the next agent needs it. Never "
    "silently override the threshold logic."
)

ACTIONS = ["auto_clear", "human_review"]

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


def _decide_action(confidence: float) -> tuple[str, bool]:
    """Returns (action, is_borderline) per the spec's threshold logic."""
    if confidence >= AUTO_CLEAR_THRESHOLD:
        return "auto_clear", False
    if confidence < HUMAN_REVIEW_THRESHOLD:
        return "human_review", False
    return "human_review", True


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
    is_borderline: bool,
) -> str:
    return (
        f"Case ID: {case_id}\n"
        f"Transaction ID: {transaction_id}\n\n"
        "Anomaly Agent findings for this transaction:\n"
        f"{json.dumps(findings, indent=2)}\n\n"
        "The action, confidence, and thresholds below have already been "
        "computed deterministically by applying the threshold logic exactly "
        "as specified - do not recompute, second-guess, or contradict them. "
        "Your only job is to write the reason field: a one-to-two sentence, "
        "plain-language explanation of this decision that references the "
        "actual finding(s) involved (or says the transaction was clean, if "
        "there are none).\n"
        f"action: {action}\n"
        "confidence (of the highest-severity finding, or 1.0 if none): "
        f"{confidence}\n"
        f"thresholds_used: {json.dumps(thresholds_used)}\n"
        f"borderline: {is_borderline} (true only when 0.80 <= confidence < "
        "0.95 - mention this explicitly in the reason if true)\n"
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
    action, is_borderline = _decide_action(confidence)
    thresholds_used = {
        "auto_clear": AUTO_CLEAR_THRESHOLD,
        "human_review": HUMAN_REVIEW_THRESHOLD,
    }
    carried_findings = [_carry_forward_finding(f) for f in findings]

    user_message = _build_user_message(
        case_id, transaction_id, findings, action, confidence, thresholds_used, is_borderline
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
