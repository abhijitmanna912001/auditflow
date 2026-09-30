# Reliability measurement

Model/agents/prompts/dataset unchanged. Stages called individually (Intake→Evidence→Anomaly→Decision), outputs under `scratch/reliability/runs/`. Runner: `runner.py`. Scoring reuses `evaluation/evaluate.py` (`load_ground_truth`, and the set-based per-case finding-type comparison from `score_finding_types`); action compared exactly with `expected_action`. Types and action are taken from Anomaly and Decision output directly (Workpaper stage not run; evaluate.py's own `score_case` is a coarser issue-count check on Workpaper rows).

## 1. Full benchmark, 3 runs per case

| Case | Expected types | Expected action | Types match | Action match | Pass (both) | Extra / missing types |
|---|---|---|---|---|---|---|
| CASE_01 | (none) | auto_clear | 3/3 | 3/3 | 3/3 | - |
| CASE_02 | (none) | auto_clear | 3/3 | 3/3 | 3/3 | - |
| CASE_03 | duplicate_invoice | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_04 | amount_mismatch | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_05 | missing_po | human_review | 0/3 | 3/3 | 0/3 | extra date_inconsistency ×3 |
| CASE_06 | missing_receipt | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_07 | vendor_mismatch | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_08 | date_inconsistency | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_09 | duplicate_invoice,amount_mismatch,missing_receipt | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_10 | vendor_mismatch,date_inconsistency | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_11 | missing_po,amount_mismatch | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_12 | missing_receipt | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_13 | currency_mismatch | human_review | 3/3 | 3/3 | 3/3 | - |
| CASE_14 | tax_mismatch | human_review | 1/3 | 1/3 | 1/3 | missing tax_mismatch ×2 |

## 2. CASE_14 (tax_mismatch), 20 runs

tax_mismatch found in **11/20** runs; missed in 9.

| Miss | INV-1014 amount | tax_amount | 200,000 in Anomaly input | Classification | extraction_notes |
|---|---|---|---|---|---|
| run00 | 246000.0 | 36000.0 | no | Intake did not carry the subtotal | Supplier's own invoice number SPS/2026/2208 is this document's own identifier, not treated as an external reference. |
| run01 | 246000.0 | 36000.0 | yes | Anomaly saw it and did not flag it | Amount is invoice total (subtotal INR 200,000.00 + GST @18% INR 36,000.00). Supplier invoice no SPS/2026/2208 is the vendor's own numbering, included as a reference/identifier. |
| run07 | 246000.0 | 36000.0 | no | Intake did not carry the subtotal | Supplier invoice no. SPS/2026/2208 is this document's own supplier-side identifier, not a reference to a separate document. |
| run10 | 246000.0 | 36000.0 | no | Intake did not carry the subtotal | Supplier invoice number SPS/2026/2208 is this document's own identifier (not a reference to another document). |
| run11 | 246000 | 36000 | no | Intake did not carry the subtotal | Supplier invoice number SPS/2026/2208 is this document's own internal reference number, not a link to another document. |
| run12 | 246000.0 | 36000.0 | no | Intake did not carry the subtotal | Supplier's own invoice number (SPS/2026/2208) is this document's identifier, not treated as a reference to another document. |
| run15 | 246000 | 36000 | no | Intake did not carry the subtotal | Supplier invoice number SPS/2026/2208 is the vendor's own numbering for this invoice, not a reference to a separate document. |
| run16 | 246000.0 | 36000.0 | no | Intake did not carry the subtotal | Supplier invoice number SPS/2026/2208 is this document's own alternate identifier, not a reference to another document. |
| run17 | 246000.0 | 36000.0 | no | Intake did not carry the subtotal | Supplier's own invoice number (SPS/2026/2208) is this document's alternate identifier, not a reference to a separate document. |

Classification counts: Intake did not carry the subtotal: 8, Anomaly saw it and did not flag it: 1.

Note: in every miss, amount=246,000 (the invoice total) and tax_amount=36,000 were carried, but Intake has no subtotal field, so the subtotal only reaches Anomaly if Intake happens to mention it in extraction_notes. In the one 'saw it' case (run01) the notes contained the subtotal and Anomaly still returned no findings. Anomaly's input check searched the full user message (evidence map + intake records) for `200000`/`200,000`.

## 3. CASE_05 (missing_po), 10 runs

Documents: INV-1005 invoice date 2026-07-21; REC-1005 (receipt) completion date 2026-07-18; bank/ledger 2026-08-18. All 10 runs: missing_po found, action human_review.

Runs with a finding other than missing_po: **8/10** (all `date_inconsistency`); 2/10 were exactly missing_po. Ground truth expects only missing_po.

- run00: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 (2026-07-21) that it references, producing an illogical document sequence." (receipt 2026-07-18, invoice 2026-07-21)
- run02: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice it references (INV-1005, dated 2026-07-21), an illogical sequence for a receipt confirming an invoice not yet issued." (receipt 2026-07-18, invoice 2026-07-21)
- run03: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the INV-1005 it references (2026-07-21), an implausible sequence for a receipt acknowledging that invoice." (receipt 2026-07-18, invoice 2026-07-21)
- run04: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice it references (INV-1005, dated 2026-07-21), an illogical sequence where the receipt predates the invoice it purports to satisfy." (receipt 2026-07-18, invoice 2026-07-21)
- run05: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 dated 2026-07-21, an unexplained sequence in which the receipt predates the invoice it references." (receipt 2026-07-18, invoice 2026-07-21)
- run07: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice it references (INV-1005, dated 2026-07-21), which is unusual sequencing though plausible for goods received prior to billing." (receipt 2026-07-18, invoice 2026-07-21)
- run08: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 dated 2026-07-21, an inverted receipt-before-invoice sequence that no document explains." (receipt 2026-07-18, invoice 2026-07-21)
- run09: `date_inconsistency` — "REC-1005 is dated 2026-07-18, three days before the invoice (INV-1005, dated 2026-07-21) that it references, an impossible sequence for a payment acknowledgment of that invoice." (receipt 2026-07-18, invoice 2026-07-21)

## 4. Cases that did not pass 3 of 3

- CASE_05: types 0/3, action 3/3, both 0/3 (extra date_inconsistency ×3)
- CASE_14: types 1/3, action 1/3, both 1/3 (missing tax_mismatch ×2)
- CASE_14 (20-run test): passed 11/20 on tax_mismatch
- CASE_05 (10-run test): 2/10 exact types; action correct 10/10
