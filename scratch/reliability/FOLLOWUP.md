# Reliability follow-up

No agent, prompt, dataset or ground-truth changes. No API calls in Part 1.

## Part 1: CASE_14, did the subtotal (200,000) reach the Anomaly Agent?

Checked the saved `anomaly_input.txt` (evidence map + Intake records) for `200000` / `200,000` in all 20 runs, and located where it appeared.

| Outcome | Subtotal reached Anomaly: yes | Subtotal reached Anomaly: no | Total |
|---|---|---|---|
| tax_mismatch found (hit) | 2 (run08, run13) | 9 | 11 |
| tax_mismatch missed | 1 (run01) | 8 | 9 |
| Total | 3 | 17 | 20 |

Where it appeared, in the 3 runs where it did:
- run08 (hit): Intake `extraction_notes` only.
- run13 (hit): Intake `extraction_notes` only.
- run01 (miss): Intake `extraction_notes` and the Evidence map (Evidence's own notes restate "INR 246,000 = INR 200,000 subtotal + INR 36,000 GST").

Findings:
- **9 of 11 hits never had the subtotal in Anomaly's input.** In those runs Anomaly flagged tax_mismatch from other information (amount 246,000, tax_amount 36,000, i.e. the 18% GST implied against the total). So the subtotal is not required for a hit, and its presence does not guarantee one.
- **One run carried the subtotal and still missed: run01.** The subtotal was in both the Intake notes and the evidence map, and Anomaly returned no findings.
- run04 (hit) mentions the word "subtotal" in its notes ("total is subtotal plus GST") but not the number 200,000, so it is counted as "no".
- Presence of the subtotal: 2/3 hits, 1/3 miss (small numbers). Hit rate when carried 2/3; when not carried 9/17 (53%).

## Part 2: CASE_05 extra date_inconsistency, old vs current code

Old = commit 8dc1c0a in a worktree at /tmp/auditflow-old (its `agents/anomaly_agent.py` has 0 mentions of tax_mismatch/currency_mismatch; current has 5). Same runner (`runner.py`, now with an `AUDITFLOW_ROOT` override and a `tagged` mode), same venv and dataset content for CASE_05. 10 runs each, executed concurrently so the two sets are close in time. Expected: only missing_po; action human_review in all 20 runs.

| Version | Runs with extra date_inconsistency |
|---|---|
| Old, 8dc1c0a | 8/10 |
| Current main | 9/10 |

### Old (8dc1c0a): extra date_inconsistency in 8/10 runs

- old00: missing_po
- old01: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before the invoice date of 2026-07-21, an out-of-sequence ordering that may simply reflect goods received before invoicing but warrants confirmation."
- old02: missing_po
- old03: missing_po, date_inconsistency
  - "The receipt REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 dated 2026-07-21, an out-of-sequence ordering that warrants manual review though it can occur with goods-received-before-invoicing."
- old04: missing_po, date_inconsistency
  - "The receipt (REC-1005) is dated 2026-07-18, three days before the invoice it references (INV-1005, dated 2026-07-21), an out-of-sequence ordering that warrants review though it may reflect early goods delivery or delayed invoicing."
- old05: missing_po, date_inconsistency
  - "Receipt REC-1005 is dated 2026-07-18, three days before invoice INV-1005 (2026-07-21), an out-of-sequence ordering that is plausible for a goods-receipt note but warrants verification."
- old06: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before the invoice date of 2026-07-21, which is an unexplained (though for a completed service potentially benign) sequence of receipt preceding invoice."
- old07: missing_po, date_inconsistency
  - "The receipt REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 it references (2026-07-21), an out-of-order sequence that may reflect legitimate goods-received-before-billing timing but is unconfirmed without the purchase order."
- old08: missing_po, date_inconsistency
  - "The receipt completion date (2026-07-18) precedes the invoice date (2026-07-21), which is flagged only as a minor sequencing note since delivery/completion before invoicing is a normal business pattern and all vendor, amount, and settlement details align."
- old09: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before its referenced invoice INV-1005 (2026-07-21), an out-of-sequence ordering that warrants review though it may reflect early goods acceptance."

### Current (main): extra date_inconsistency in 9/10 runs

- new00: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before the invoice it references (INV-1005, dated 2026-07-21), an illogical sequence suggesting a misdated or unrelated receipt."
- new01: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before the INV-1005 invoice date of 2026-07-21 that it explicitly references, so the receipt appears to predate the document it acknowledges, though goods-receipt-before-invoicing can be legitimate practice."
- new02: missing_po, date_inconsistency
  - "Receipt REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 it references (2026-07-21), an unexplained out-of-sequence dating."
- new03: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before the invoice it acknowledges (INV-1005, dated 2026-07-21), an illogical sequence for a receipt covering the invoiced amount."
- new04: missing_po, date_inconsistency
  - "Receipt REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 it references (2026-07-21), an out-of-sequence ordering that the otherwise consistent amounts do not explain."
- new05: missing_po, date_inconsistency
  - "The receipt REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 dated 2026-07-21, an illogical sequence suggesting misdating or an out-of-order event trail."
- new06: missing_po, date_inconsistency
  - "The receipt REC-1005 is dated 2026-07-18, three days before the invoice date of 2026-07-21, an unexplained chronological inversion between acceptance and invoicing."
- new07: missing_po, date_inconsistency
  - "REC-1005 is dated 2026-07-18, three days before the invoice INV-1005 it references (2026-07-21), an illogical sequence suggesting either a misrecorded date or a receipt that does not actually correspond to this invoice."
- new08: missing_po, date_inconsistency
  - "The receipt is dated 2026-07-18, three days before the invoice date of 2026-07-21, yet it references INV-1005, an out-of-sequence ordering that the remaining documents do not resolve."
- new09: missing_po

Read: the extra date_inconsistency is present in the old code too (8/10 vs 9/10), so it predates the currency/tax anomaly types; the difference between versions (1 run) is within run-to-run noise at n=10. Receipt REC-1005 is dated 2026-07-18 and invoice INV-1005 2026-07-21. Old-code explanations more often hedge that early receipt can be normal; current-code ones more often call it "illogical", though both flag it.
