# Atomicity test: does one missing document produce one finding?

Branch `test/atomicity`. Scratch cases built from CASE_01 (IDs 1001 -> 91xx). No agent code, prompts, dataset files or ground truth touched. Tracing off (NEATLOGS_API_KEY unset). 4 cases x 5 runs = 20 runs, 0 errors.

Data: `raw_runs.json` (Anomaly output, Decision output and workpaper per run). Run via `run_capture.py`, which wraps `run_anomaly_agent` / `run_decision_agent` inside `workpaper_agent` to record what `run_full_pipeline` passes between stages. The finding types and explanations below come from that Anomaly output, because the workpaper merges findings into one row and drops them. An earlier 20-run pass with `run_atomicity.py` (workpaper only, `raw_runs_pass1.json`) is summarised at the end as a cross-check.

Case construction: the invoice keeps its `PO Reference` line (the CASE_05 / CASE_12 convention, which is what makes an absence meaningful). The ledger's `Supporting Documents` line lists only documents that exist. In CASE_91 the receipt and bank narration still cite PO-9101.

## Summary

| Case | Missing | Expected | Runs exactly as expected | Extra / derived findings |
|---|---|---|---|---|
| CASE_91 | PO | 1 x `missing_po` | **5/5** | none |
| CASE_92 | receipt | 1 x `missing_receipt` | **5/5** | none |
| CASE_93 | bank statement | 1 finding of "matching missing type" | **0/5** | none, but also no finding at all (see below) |
| CASE_94 | PO + receipt + bank | judgment | n/a | 2 findings x5; 1 run added a 3rd |

## (a) CASE_91: all present except PO

| Run | Finding types | Documents cited | Confidence | Action |
|---|---|---|---|---|
| 1 | missing_po | BNK-9101, INV-9101, REC-9101 | 0.90 | human_review |
| 2 | missing_po | INV-9101, REC-9101, BNK-9101 | 0.90 | human_review |
| 3 | missing_po | INV-9101, REC-9101, BNK-9101, LED-9101 | 0.88 | human_review |
| 4 | missing_po | INV-9101, BNK-9101, REC-9101 | 0.90 | human_review |
| 5 | missing_po | INV-9101, REC-9101, BNK-9101, LED-9101 | 0.93 | human_review |

Exactly one finding in all 5 runs, severity medium each time. No amount_mismatch or other derived findings. Cited documents vary (3 or 4 of the present docs), which only matters if document sets are scored strictly.

## (b) CASE_92: all present except receipt

| Run | Finding types | Documents cited | Confidence | Action |
|---|---|---|---|---|
| 1-5 | missing_receipt | PO-9102, INV-9102, BNK-9102, LED-9102 | 0.82, 0.80, 0.80, 0.85, 0.82 | human_review (all) |

Exactly one finding in all 5 runs, severity medium, identical document set each time. No extra findings.

## (c) CASE_93: all present except bank statement

| Run | Finding types | Documents cited | Confidence | Action |
|---|---|---|---|---|
| 1-5 | (none) | - | 1.0 (Decision) | **auto_clear** (all) |

The pipeline gave zero findings and auto-cleared all 5 runs. This does not meet the expectation of one finding, but the expectation cannot be met under the current design: there is no `missing_bank_statement` type (the allowed types are the eight in spec section 3), and the spec defines missing_* only for PO and receipt. Nothing produced extra findings; nothing was flagged at all. Note that the ledger in this case does not cite BNK-9103 and no remaining document references a bank payment, so the absence is not visible from the remaining documents. Whether a missing bank statement should be flagged is a spec decision.

## (d) CASE_94: only invoice + ledger

| Run | Finding types | Documents cited | Confidence | Action |
|---|---|---|---|---|
| 1 | missing_po (0.92, high), missing_receipt (0.80, medium) | INV-9104 / INV-9104, LED-9104 | 0.92 | human_review |
| 2 | missing_po (0.90, high), missing_receipt (0.85, medium) | same | 0.90 | human_review |
| 3 | missing_po (0.90, high), missing_receipt (0.85, medium) | same | 0.90 | human_review |
| 4 | missing_po (0.95, high), missing_receipt (0.80, medium), **date_inconsistency (0.35, low)** | INV-9104 / INV-9104, LED-9104 / INV-9104, LED-9104 | 0.95 | human_review |
| 5 | missing_po (0.90, high), missing_receipt (0.85, medium) | same as run 1 | 0.90 | human_review |

Consistent behaviour: one finding per structurally missing document type (PO, receipt), never a bank finding. Missing PO is rated high here versus medium in CASE_91, so the same fact is scored differently depending on what else is absent. Decision-level confidence equals the highest finding confidence (the low-confidence extra in run 4 did not change the action).

### Extra finding (run 4)

`date_inconsistency`, documents INV-9104 + LED-9104, low, 0.35:

> "The ledger entry is dated 2026-07-25, twenty days after the invoice date of 2026-07-05, which is likely a normal posting lag but is not the date corroboration the evidence map asserts."

This is a derived finding: it exists only because the PO, receipt and bank documents that would explain the 07-25 date are absent. The explanation itself concedes it is "likely a normal posting lag". The same dates appear in the clean CASE_01 with no such finding.

Missing-document explanations, for reference (run 2):
- missing_po: "Invoice INV-9104 explicitly references PO-9104 but no purchase order document exists anywhere in the transaction evidence, leaving the 47,200 INR charge unauthorized by any procurement approval."
- missing_receipt: "No delivery or goods receipt document exists for this transaction, so fulfillment of the invoiced office furniture cannot be confirmed before the ledger debit was posted."

## Cross-check: first pass (workpaper only, separate 20 runs)

- CASE_91: 5/5 single "Missing PO" row (confidence 0.90-0.95, human_review).
- CASE_92: **4/5** "Missing receipt" rows (0.80-0.88); **run 3 was "Clean", 1.0, auto_clear**, i.e. the missing receipt was not flagged at all. Not reproduced in the capture pass (5/5 flagged), so the false clear rate for a missing receipt is 1 in 10 across both passes. No finding detail is available for that run (workpaper only).
- CASE_93: 5/5 "Clean", auto_clear (same as the capture pass).
- CASE_94: 5/5 rows "Missing PO; missing receipt" (variants: "no receipt/payment evidence", "no receipt"), confidence 0.82-0.92, human_review. The workpaper merges findings into a single row, so finding counts (and the date_inconsistency extra) are not visible there.

## Observations

1. Atomicity holds for a single missing PO or receipt: no run produced an amount_mismatch or any other derived finding.
2. The one derived finding (CASE_94 run 4, date_inconsistency) appeared when three documents were missing.
3. A missing bank statement is invisible to the pipeline (auto_clear 5/5); no finding type covers it.
4. Auto-clear on a missing receipt happened once in 10 runs (pass 1, CASE_92 run 3).
5. Sample size is 5 per case per pass, so these rates are indicative, not statistical.
