"""
AuditFlow Evaluation Script

Diffs Workpaper Agent output against ground truth (from /dataset) to produce
accuracy, false positive, missed exception, latency, and cost metrics.

Used to generate the V1 -> V2 improvement story: run this against a V1 agent
run and a V2 agent run over the same benchmark, then compare the two reports.

Usage:
    python evaluate.py --predictions runs/v1_predictions.json --dataset ../dataset --output runs/v1_report.json
    python evaluate.py --predictions runs/v2_predictions.json --dataset ../dataset --output runs/v2_report.json
    python evaluate.py --compare runs/v1_report.json runs/v2_report.json

See ../docs/agent-spec.md for the ground truth and prediction schema this
script expects. Ground truth files live in ../dataset/*.json (one file per
case, per the "Ground truth format" section of the spec).
"""

import json
import argparse
import glob
import os
from collections import defaultdict

ALLOWED_FINDING_TYPES = {
    "duplicate_invoice",
    "amount_mismatch",
    "missing_po",
    "missing_receipt",
    "vendor_mismatch",
    "date_inconsistency",
}
ALLOWED_ACTIONS = {"auto_clear", "human_review"}


def load_ground_truth(dataset_dir):
    """Load all case_*.json ground truth files from the dataset directory."""
    cases = {}
    for path in sorted(glob.glob(os.path.join(dataset_dir, "case_*.json"))):
        with open(path) as f:
            case = json.load(f)
        validate_case(case, path)
        cases[case["case_id"]] = case
    if not cases:
        raise ValueError(
            f"No ground truth case files found in {dataset_dir} "
            f"(expected files matching case_*.json)"
        )
    return cases


def validate_case(case, path):
    """Validation checklist from docs/agent-spec.md - fail loudly on bad ground truth."""
    errors = []
    if "case_id" not in case:
        errors.append("missing case_id")
    if case.get("expected_action") not in ALLOWED_ACTIONS:
        errors.append(
            f"expected_action must be one of {ALLOWED_ACTIONS}, "
            f"got {case.get('expected_action')!r}"
        )
    findings = case.get("expected_findings", [])
    seen_findings = set()
    for i, finding in enumerate(findings):
        if finding.get("type") not in ALLOWED_FINDING_TYPES:
            errors.append(
                f"expected_findings[{i}].type must be one of "
                f"{ALLOWED_FINDING_TYPES}, got {finding.get('type')!r}"
            )

        docs = finding.get("documents", [])
        if len(docs) != len(set(docs)):
            errors.append(
                f"expected_findings[{i}] has duplicate document IDs within "
                f"its documents list: {docs}"
            )

        fingerprint = (finding.get("type"), tuple(sorted(set(docs))))
        if fingerprint in seen_findings:
            errors.append(
                f"expected_findings[{i}] duplicates an earlier finding "
                f"(same type {finding.get('type')!r} and same documents {docs})"
            )
        seen_findings.add(fingerprint)

    if not findings and case.get("expected_action") != "auto_clear":
        errors.append(
            "case has empty expected_findings but expected_action is not "
            "'auto_clear' - a clean case must auto_clear"
        )
    if errors:
        raise ValueError(f"Invalid ground truth in {path}:\n  - " + "\n  - ".join(errors))


def load_predictions(predictions_path):
    """
    Load actual agent output. Expected shape: a list of Workpaper Agent
    outputs (one per case), each matching the schema in agent-spec.md
    section 5, keyed by case_id for lookup.

    Also expects, per case, optional timing/cost metadata if present:
      { "case_id": ..., "rows": [...], "summary": {...},
        "latency_seconds": 12.4, "cost_usd": 0.031 }
    """
    with open(predictions_path) as f:
        raw = json.load(f)
    predictions = {}
    for entry in raw:
        predictions[entry["case_id"]] = entry
    return predictions


def findings_from_workpaper(workpaper_entry):
    """
    Extract a comparable (finding_type, action) summary from a Workpaper
    Agent output. The workpaper's `rows` list holds one row per transaction;
    we treat any row with a non-"Clean" finding as a detected issue.
    """
    findings = []
    for row in workpaper_entry.get("rows", []):
        finding_text = row.get("finding", "")
        if finding_text and finding_text.lower() != "clean":
            findings.append(
                {
                    "finding_text": finding_text,
                    "action": row.get("action"),
                    "confidence": row.get("confidence"),
                }
            )
    return findings


def score_case(expected, predicted):
    """
    Compare one case's ground truth against predicted output.
    Returns a dict with correctness signals for this case.

    Scoring is intentionally coarse-grained (issue-count and action-level),
    not finding-type-exact-match, because the Workpaper Agent's `finding`
    field is a plain-language summary, not a typed field. For stricter
    finding-type scoring, compare against Anomaly Agent output directly
    instead of Workpaper output.
    """
    expected_issue_count = len(expected.get("expected_findings", []))
    expected_action = expected["expected_action"]

    predicted_findings = findings_from_workpaper(predicted)
    predicted_issue_count = len(predicted_findings)

    # Case-level action: did we get at least one row's action right relative
    # to the overall expected action? For a clean case (0 expected issues),
    # correct means predicted_issue_count is also 0.
    if expected_issue_count == 0:
        action_correct = predicted_issue_count == 0
        is_false_positive = predicted_issue_count > 0
        is_missed_exception = False
    else:
        action_correct = predicted_issue_count > 0
        is_false_positive = False
        is_missed_exception = predicted_issue_count == 0

    return {
        "case_id": expected["case_id"],
        "expected_issue_count": expected_issue_count,
        "predicted_issue_count": predicted_issue_count,
        "expected_action": expected_action,
        "action_correct": action_correct,
        "false_positive": is_false_positive,
        "missed_exception": is_missed_exception,
        "latency_seconds": predicted.get("latency_seconds"),
        "cost_usd": predicted.get("cost_usd"),
    }


def build_report(ground_truth, predictions):
    case_results = []
    missing_predictions = []

    for case_id, expected in ground_truth.items():
        if case_id not in predictions:
            missing_predictions.append(case_id)
            continue
        case_results.append(score_case(expected, predictions[case_id]))

    total = len(case_results)
    correct = sum(1 for r in case_results if r["action_correct"])
    false_positives = sum(1 for r in case_results if r["false_positive"])
    missed_exceptions = sum(1 for r in case_results if r["missed_exception"])

    latencies = [r["latency_seconds"] for r in case_results if r["latency_seconds"] is not None]
    costs = [r["cost_usd"] for r in case_results if r["cost_usd"] is not None]

    report = {
        "total_cases": total,
        "missing_predictions": missing_predictions,
        "accuracy": round(correct / total, 4) if total else None,
        "false_positives": false_positives,
        "missed_exceptions": missed_exceptions,
        "avg_latency_seconds": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "avg_cost_usd": round(sum(costs) / len(costs), 4) if costs else None,
        "case_results": case_results,
    }
    return report


def print_report(report, label=""):
    title = f"Evaluation Report {label}".strip()
    print(f"\n{'=' * len(title)}\n{title}\n{'=' * len(title)}")
    print(f"Cases evaluated:     {report['total_cases']}")
    if report["missing_predictions"]:
        print(f"  WARNING - missing predictions for: {report['missing_predictions']}")
    print(f"Accuracy:            {report['accuracy']}")
    print(f"False positives:     {report['false_positives']}")
    print(f"Missed exceptions:   {report['missed_exceptions']}")
    print(f"Avg latency (s):     {report['avg_latency_seconds']}")
    print(f"Avg cost ($):        {report['avg_cost_usd']}")
    print()
    for r in report["case_results"]:
        status = "OK" if r["action_correct"] else "FAIL"
        flag = " [FALSE POSITIVE]" if r["false_positive"] else ""
        flag += " [MISSED]" if r["missed_exception"] else ""
        print(
            f"  [{status}] {r['case_id']}: expected {r['expected_issue_count']} "
            f"issue(s), predicted {r['predicted_issue_count']}{flag}"
        )


def compare_reports(report_a_path, report_b_path):
    with open(report_a_path) as f:
        a = json.load(f)
    with open(report_b_path) as f:
        b = json.load(f)

    print("\n=== V1 vs V2 Comparison ===")
    print(f"{'Metric':<22}{'V1':>10}{'V2':>10}{'Delta':>10}")

    def row(label, key, higher_is_better=True, is_pct=False):
        v1 = a.get(key)
        v2 = b.get(key)
        if v1 is None or v2 is None:
            print(f"{label:<22}{'n/a':>10}{'n/a':>10}")
            return
        delta = v2 - v1
        arrow = ""
        if delta != 0:
            improved = (delta > 0) == higher_is_better
            arrow = " (better)" if improved else " (worse)"
        v1_s = f"{v1:.1%}" if is_pct else f"{v1}"
        v2_s = f"{v2:.1%}" if is_pct else f"{v2}"
        d_s = f"{delta:+.1%}" if is_pct else f"{delta:+.4g}"
        print(f"{label:<22}{v1_s:>10}{v2_s:>10}{d_s:>10} {arrow.strip()}")

    row("Accuracy", "accuracy", higher_is_better=True, is_pct=True)
    row("False positives", "false_positives", higher_is_better=False)
    row("Missed exceptions", "missed_exceptions", higher_is_better=False)
    row("Avg latency (s)", "avg_latency_seconds", higher_is_better=False)
    row("Avg cost ($)", "avg_cost_usd", higher_is_better=False)
    print()


def main():
    parser = argparse.ArgumentParser(description="AuditFlow benchmark evaluation")
    parser.add_argument("--predictions", help="Path to predictions JSON (list of Workpaper Agent outputs)")
    parser.add_argument("--dataset", default="../dataset", help="Path to dataset directory (ground truth case_*.json files)")
    parser.add_argument("--output", help="Path to write the report JSON")
    parser.add_argument("--compare", nargs=2, metavar=("REPORT_A", "REPORT_B"), help="Compare two previously generated reports (e.g. V1 vs V2)")
    args = parser.parse_args()

    if args.compare:
        compare_reports(*args.compare)
        return

    if not args.predictions:
        parser.error("--predictions is required unless using --compare")

    ground_truth = load_ground_truth(args.dataset)
    predictions = load_predictions(args.predictions)
    report = build_report(ground_truth, predictions)
    print_report(report, label=f"({args.predictions})")

    if args.output:
        os.makedirs(os.path.dirname(args.output), exist_ok=True) if os.path.dirname(args.output) else None
        with open(args.output, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nReport written to {args.output}")


if __name__ == "__main__":
    main()