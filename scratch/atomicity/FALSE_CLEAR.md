# False-clear measurement: missing receipt (CASE_92) vs missing PO (CASE_91)

Branch `test/atomicity`. Same scratch cases as before (`cases/CASE_92` = no receipt, `cases/CASE_91` = no PO). Full pipeline via `run_full_pipeline`; `run_falseclear.py` wraps the four stage functions inside `workpaper_agent` to capture each stage's raw output. Agent code, prompts, dataset and ground truth untouched. Tracing off. 30 runs, 0 errors, no 401.

Raw data: `raw_falseclear_CASE_92.json` (20 runs), `raw_falseclear_CASE_91.json` (10 runs). Each run holds `intake`, `evidence`, `anomaly`, `decision` and `workpaper`.

## Headline

**There were no auto-clears in these 30 runs.** CASE_92 flagged the missing receipt 20/20 and CASE_91 flagged the missing PO 10/10. The false clear seen earlier (first pass, CASE_92 run 3) did not reproduce, so there is no failing stage to attribute in this data.

| Case | Runs | Flagged missing document | Auto-cleared |
|---|---|---|---|
| CASE_92 (no receipt) | 20 | **20** (all `missing_receipt`, human_review) | **0** |
| CASE_91 (no PO) | 10 | **10** (all `missing_po`, human_review) | **0** |

Each flagged run carries a single Anomaly finding of the matching type, in both cases.

## Which stage failed on auto-clear runs

None to report: there are zero auto-clear runs, so the "Evidence returned empty or incomplete missing_evidence" vs "Evidence right, Anomaly returned no finding" question has no instances here.
- In all 30 runs Intake returned exactly the 4 present documents (no invented document), Evidence listed the absent type in `missing_evidence` and Anomaly turned it into a finding.
- Evidence's notes explicitly rejected the consistency fallacy in the runs I read. CASE_92 run 1: "No goods receipt or delivery confirmation document was provided to confirm the goods/services were actually received; the successful bank debit and ledger posting only confirm payment occurred, not that receipt conditions were satisfied. No pattern in this case indicates this vendor is exempt from requiring such a document, so its absence is flagged rather than assumed acceptable."
- Anomaly explanation, CASE_92 run 1: "No goods receipt or delivery confirmation document exists anywhere in the transaction chain, so receipt of the goods/services cannot be verified even though payment posted successfully."

## evidence_confidence

| Case | Flagged runs | Auto-cleared runs |
|---|---|---|
| CASE_92 | n=20: min 0.72, mean 0.80, max 0.88 | none |
| CASE_91 | n=10: min 0.62, mean 0.69, max 0.78 | none |

Evidence confidence never reached the 0.95 auto-clear threshold in either case. Decision confidence for CASE_92 ranged 0.72-0.88, which is at or below the 0.80 human_review threshold in some runs (it still routed to human_review). CASE_91 decision confidence was 0.88-0.93.

Notably, CASE_91 (missing PO) has lower evidence confidence than CASE_92 (0.62-0.78 vs 0.72-0.88), because in CASE_91 the invoice, receipt and bank statement all cite a PO that isn't there, whereas in CASE_92 nothing in the remaining documents points to a receipt.

## Extra `missing_evidence` entries (Evidence over-listing)

CASE_92 Evidence added items beyond the receipt in 5 of 20 runs (3, 7, 8, 17, 20), e.g. "standalone_payment_receipt (only bank debit record present, no vendor-issued payment confirmation)", "separate tax breakdown documentation for the GST component" (run 7), "payment_receipt_or_remittance_advice" (run 8), "payment_confirmation_receipt". These have the lowest confidences of the case (0.72-0.82). They did not become extra Anomaly findings: every CASE_92 run has exactly one finding. CASE_91 always listed only the purchase order.

## Caveats

- The earlier false clear (CASE_92, first pass run 3: workpaper "Clean", 1.0, auto_clear) was captured at workpaper level only, so which stage failed cannot be determined for it. Across all CASE_92 runs so far (5 first pass + 5 capture pass + 20 here = 30) it is 1 auto-clear in 30. With 0/20 here, the 95% upper bound on the true rate is about 14-16% (rule of three: 3/20 = 15%), so this run does not rule out a rate of a few percent.
- CASE_91/92 are synthetic CASE_01 derivatives with a very clean document set; a real messy case may behave differently.
