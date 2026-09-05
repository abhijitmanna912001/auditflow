# Evaluation

`evaluate.py` scores agent output against the ground truth cases in `/dataset`.

## Usage

Run a benchmark and save a report:

    python evaluate.py --predictions runs/v1_predictions.json --dataset ../dataset --output runs/v1_report.json

Repeat after an improvement pass:

    python evaluate.py --predictions runs/v2_predictions.json --dataset ../dataset --output runs/v2_report.json

Compare the two:

    python evaluate.py --compare runs/v1_report.json runs/v2_report.json

## Predictions file format

A JSON list of Workpaper Agent outputs (see docs/agent-spec.md section 5), one per case, optionally with `latency_seconds` and `cost_usd` added per case for timing/cost metrics:

    [
      {
        "case_id": "CASE_01",
        "rows": [...],
        "summary": {...},
        "latency_seconds": 8.2,
        "cost_usd": 0.02
      }
    ]

## What gets validated automatically

Ground truth files are validated against the rules in `docs/agent-spec.md` (allowed finding types, allowed actions, clean-case convention) every time they're loaded — a malformed case file fails loudly with a specific error rather than silently producing wrong scores.

## Scoring notes

Scoring is case-level and action-level (did we flag/not-flag correctly), not exact finding-type matching, because the Workpaper Agent's `finding` field is a plain-language summary. `runs/` (predictions and reports) is gitignored except for this placeholder — don't commit raw run artifacts, they're regenerated each time.