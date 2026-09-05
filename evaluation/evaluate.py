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
        case_folder = os.path.join(dataset_dir, case.get("case_id", ""))
        validate_case(case, path, case_folder)

        if case["case_id"] in cases:
            raise ValueError(
                f"Duplicate case_id {case['case_id']!r} found in {path} "
                f"(already loaded from another file) - case_id must be "
                f"unique across the dataset"
            )
        cases[case["case_id"]] = case
    if not cases:
        raise ValueError(
            f"No ground truth case files found in {dataset_dir} "
            f"(expected files matching case_*.json)"
        )
    return cases


def _fixture_documents(case_folder):
    """
    Return the set of document IDs that have a matching fixture file in
    dataset/<case_id>/. Document ID is the filename without extension
    (e.g. dataset/CASE_04/INV-104.txt -> "INV-104"). Returns None if the
    case folder doesn't exist at all, so callers can distinguish "no
    fixtures directory" from "fixtures directory exists but is empty".
    """
    if not os.path.isdir(case_folder):
        return None
    return {
        os.path.splitext(fname)[0]
        for fname in os.listdir(case_folder)
        if os.path.isfile(os.path.join(case_folder, fname))
    }


def validate_case(case, path, case_folder=None):
    """Validation checklist from docs/agent-spec.md - fail loudly on bad ground truth."""
    errors = []
    if "case_id" not in case:
        errors.append("missing case_id")
    if "transaction_id" not in case:
        errors.append(
            "missing transaction_id (required - every case must carry its "
            "TXN_NN mapping in ground truth, matching what Evidence/Anomaly/"
            "Decision Agent output will use)"
        )
    if case.get("expected_action") not in ALLOWED_ACTIONS:
        errors.append(
            f"expected_action must be one of {ALLOWED_ACTIONS}, "
            f"got {case.get('expected_action')!r}"
        )

    fixture_docs = _fixture_documents(case_folder) if case_folder else None

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

        if fixture_docs is not None:
            missing_fixtures = [d for d in docs if d not in fixture_docs]
            if missing_fixtures:
                errors.append(
                    f"expected_findings[{i}] references document(s) "
                    f"{missing_fixtures} with no matching fixture file in "
                    f"{case_folder}/"
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


def load_anomaly_predictions(anomaly_predictions_path):
    """
    Load typed Anomaly Agent output for per-finding-type precision/recall.
    Expected shape: a JSON list of Anomaly Agent outputs (agent-spec.md
    section 3), one entry per transaction, each with case_id and findings[].

    This is optional and separate from the Workpaper-based --predictions
    scoring above, because Workpaper output only has a plain-language
    `finding` string, not a typed `type` field, so it can't be scored
    per-finding-type. Pass --anomaly-predictions to get this breakdown.
    """
    with open(anomaly_predictions_path) as f:
        raw = json.load(f)
    by_case = defaultdict(list)
    for entry in raw:
        by_case[entry["case_id"]].extend(entry.get("findings", []))
    return by_case


def score_finding_types(ground_truth, anomaly_predictions):
    """
    Per-finding-type precision/recall, comparing expected_findings[].type
    (ground truth) against predicted findings[].type (Anomaly Agent output),
    matched by case_id. A prediction counts as a true positive for a type if
    that type appears in both the expected and predicted sets for that case
    (set-based per case, not exact document-list matching).
    """
    tp = defaultdict(int)
    fp = defaultdict(int)
    fn = defaultdict(int)

    for case_id, case in ground_truth.items():
        expected_types = {f["type"] for f in case.get("expected_findings", [])}
        predicted_types = {
            f.get("type") for f in anomaly_predictions.get(case_id, []) if f.get("type")
        }

        for t in expected_types & predicted_types:
            tp[t] += 1
        for t in predicted_types - expected_types:
            fp[t] += 1
        for t in expected_types - predicted_types:
            fn[t] += 1

    breakdown = {}
    for t in ALLOWED_FINDING_TYPES:
        t_tp, t_fp, t_fn = tp[t], fp[t], fn[t]
        precision = t_tp / (t_tp + t_fp) if (t_tp + t_fp) else None
        recall = t_tp / (t_tp + t_fn) if (t_tp + t_fn) else None
        if t_tp or t_fp or t_fn:
            breakdown[t] = {
                "precision": round(precision, 4) if precision is not None else None,
                "recall": round(recall, 4) if recall is not None else None,
                "true_positives": t_tp,
                "false_positives": t_fp,
                "false_negatives": t_fn,
            }
    return breakdown


def print_finding_breakdown(breakdown):
    if not breakdown:
        print("(no finding-type data - pass --anomaly-predictions for this breakdown)")
        return
    print(f"\n{'Finding type':<20}{'Precision':>12}{'Recall':>10}{'TP':>6}{'FP':>6}{'FN':>6}")
    for t, m in sorted(breakdown.items()):
        p = f"{m['precision']:.0%}" if m["precision"] is not None else "n/a"
        r = f"{m['recall']:.0%}" if m["recall"] is not None else "n/a"
        print(f"{t:<20}{p:>12}{r:>10}{m['true_positives']:>6}{m['false_positives']:>6}{m['false_negatives']:>6}")


def build_report(ground_truth, predictions, anomaly_predictions=None):
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
        "finding_type_breakdown": score_finding_types(ground_truth, anomaly_predictions) if anomaly_predictions else {},
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

    print("\nPer-finding-type precision/recall:")
    print_finding_breakdown(report.get("finding_type_breakdown", {}))


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
    parser.add_argument("--anomaly-predictions", help="Optional: path to Anomaly Agent output JSON, for per-finding-type precision/recall")
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
    anomaly_predictions = load_anomaly_predictions(args.anomaly_predictions) if args.anomaly_predictions else None
    report = build_report(ground_truth, predictions, anomaly_predictions)
    print_report(report, label=f"({args.predictions})")

    if args.output:
        os.makedirs(os.path.dirname(args.output), exist_ok=True) if os.path.dirname(args.output) else None
        with open(args.output, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nReport written to {args.output}")


if __name__ == "__main__":
    main()