# Mixed pile 3: shared documents and clustering

Branch `test/mixedpile3` (from `test/mixedpile2`). No agent, prompt, dataset or ground-truth file changed. Tracing off, no 401. Full pipeline not run. Piles are the re-keyed piles from mixedpile2 (`intake_A_M/B/C.json` copied unchanged).

## What was built (`group.py`, v3; it reads only the Intake JSON)

1. **Anchors:** groups are built only from invoices, POs and receipts (a GRN is a receipt), by union-find over their IDs and references. A component containing an invoice or PO becomes a group. Bank statements and ledger entries never join groups.
2. **Attach:** each bank statement, ledger entry and reference-less receipt is attached to every group whose documents or dangling reference tokens it cites. A document that matches several groups is linked to each, recorded as `shared`, and never merges them. Documents with no reference match go to one model call that returns zero, one or several groups plus a confidence and reason.
3. **Cluster:** documents still unplaced go to one model call that clusters them among themselves. The code enforces 2+ documents, identical vendor string, confidence >= 0.7 and stated reasons; otherwise the cluster is rejected. A cluster is not a group; it stays flagged for a human.
4. **Unplaced report:** every unplaced document is listed with type, vendor, amount, date, reason, and cluster status (`groups_*_r*.json` -> `unplaced_report`).

## Requested runs: A + multi-payment statement, B, C (3 runs each)

| Variant | Runs | Correct | Wrong | Unplaced | Split | Wrongly merged | Groups |
|---|---|---|---|---|---|---|---|
| A + M | 1-3 | 67 / 67 / 67 | 0 | 0 | 0 | 0 | 14 |
| B | 1-3 | 67 / 67 / 67 | 0 | 0 | 0 | 0 | 14 |
| C | 1-3 | 67 / 67 / 67 | 0 | 0 | 0 | 0 | 17 (14 + 3 distractor groups) |

**Variance: none in any metric across the 9 runs.** Only the model's stated confidences varied.

Answers:
- **Do the 8 documents of CASE_05 and CASE_11 now form the 2 correct groups?** Yes, in 9 of 9 runs, as 2 groups of 4 with no foreign documents. The invoice is now an anchor, so a missing PO no longer leaves the case without a group. In mixedpile2 they were all unplaced.
- **Does the multi-payment statement stay out of merging?** Yes. In A + M its 8 citations make it shared across 4 groups (CASE_01, 02, 04, 08) in 3 of 3 runs, and no groups were merged. (In mixedpile2 it fused 4 cases into one 21-document group.) In the extra C + M runs the model linked it to the same 4 groups on its own: "This bank statement covers four separate settlement transactions matching Vertex Print (G13), Horizon Office Systems (G02), CloudDesk (G09), and BluePeak Training (G10) by vendor and amount." (confidence 0.75, run 1).
- **How many wrong merges did the clustering create?** **0.** But in A, B and C the clustering step was never called: nothing was left unplaced. To exercise it I added a stress variant D (below). Across its 3 runs it produced 10 clusters, 0 impure, 0 rejected.
- **Documents placed wrong / unplaced in A, B, C:** 0 and 0.

The requested variants therefore look perfect, which mostly reflects that blanking references on receipts, bank and ledger left every case's invoice and PO intact as an anchor.

## Extra: stress variant D (not requested; needed to measure the clustering)

D = C minus the invoice and PO of CASE_01, 02, 06 and 13, so those four cases have only receipt, bank and ledger documents (references blanked) and no anchor. The distractors stay: two Horizon invoices and a CloudDesk PO that look like CASE_01 and CASE_02. CASE_06 (Meridian Network Components) and CASE_13 (Meridian Cloud Services) have near-identical vendor names. Built by `build_stress.py`, which reads the key only to choose what to remove; `group.py` never does. 59 real documents remain.

| Run | Correct | Unplaced (of which clustered) | Clusters (impure) | Wrongly merged groups | Split |
|---|---|---|---|---|---|
| 1 | 51 | 8 (7 in 3 clusters) | 3 (0) | 1 | 0 |
| 2 | 49 | 10 (9 in 4 clusters) | 4 (0) | 1 | 0 |
| 3 | 52 | 7 (6 in 3 clusters) | 3 (0) | **2** | 0 |

Note: "Correct" here is by majority case in the group, so it counts CASE_02's and CASE_01's documents as correct even inside the contaminated groups below. The wrong-merge column is the honest signal.

**Clustering worked.** Every cluster was a real case's own documents: CASE_06 bank + ledger (141,600 INR, 2026-08-28), CASE_13 bank + ledger (415,000 INR), CASE_01 bank + ledger + receipt (47,200 INR), and in runs 2 and 3 CASE_11 bank + ledger. The two Meridian vendors were never mixed. Sample reason: "Same vendor, identical amount (141600.0 INR) and identical date (2026-08-28) across bank statement and ledger entry." CASE_13's receipt (no amount stated) stayed unplaced in all 3 runs: "No amount stated and vendor Meridian Cloud Services Inc. does not correspond to any group."

**Wrong merges (all from the attach step, not clustering).** A lookalike distractor group swallowed a real case's documents:

1. **CASE_02 -> the orphan CloudDesk PO (all 3 runs).** Group G11 = PO-19740 (the distractor PO, 93,220 INR) + CASE_02's bank BNK-50320, ledger LED-94393 and receipt REC-64864 (all 94,400 INR). Reasons quoted:
   - BNK-50320 (0.6): "Vendor CloudDesk Software India matches G11, amount 94400 close to PO total but not identical."
   - LED-94393 (0.6): "Vendor CloudDesk Software India matches G11's PO, though amount 94400 differs slightly from PO amount 93220."
   - REC-64864 (0.7, run 3): "Vendor CloudDesk Software matches G11; amount 94400 close to PO total 93220 with a small tax-related discrepancy."
2. **CASE_01 -> a distractor invoice (run 3 only).** Group G13 = INV-61960 (distractor, 46,905 INR, dated 07-06) + CASE_01's BNK-70658, LED-39140, REC-98450 (47,200 INR). Quoted:
   - BNK-70658 (0.6): "Vendor Horizon Office Systems and amount 47200 INR are closer to G13's invoice timeline (07-06) than G12's, though not an exact amount match."
   - REC-98450 (0.65): "Vendor Horizon Office Systems and date 2026-07-09 fit shortly after G13's invoice date (07-06), though amount 47200 differs slightly from invoice total 46905."
   In runs 1 and 2 the same CASE_01 documents were clustered correctly and stayed unplaced.

All 12 wrong attachments (9 for CASE_02, 3 for CASE_01) had stated confidence 0.60-0.70. That is not a usable cutoff: 54 of the 432 attachments I judged correct also sit at or below 0.70 (lowest 0.40; my correct/wrong classification of attachments is a rough heuristic). For example CASE_11's bank and ledger were correctly attached at 0.55 in B run 1 despite their 129,800 vs 118,000 amount difference. I did not tune any threshold.

**Variance in D:** CASE_11's bank and ledger were attached to their own invoice group in run 1 but left unplaced and clustered in runs 2 and 3. So CASE_11 ends up as a group plus a leftover cluster in runs 2 and 3 (not counted as a split, since clusters aren't groups; it would probably yield a false missing-document reading on the leftover). CASE_05 and CASE_11 are one group in D run 1, and only CASE_05 in runs 2 and 3.

## Summary

- Fix 1 (anchor-only groups, shared documents) worked: the multi-payment statement no longer merges anything, the 8 CASE_05/CASE_11 documents form their 2 groups in 9 of 9 runs, and all 9 requested runs are 67/67 with zero variance.
- Fix 2 (clustering) worked when it had work to do: 10 clusters, 0 wrong. It is the attach step that makes the wrong merges, and only when a lookalike group exists and the real anchor is absent. A wrong merge is worse than an unplaced document, so the next fix is to make the attach step refuse amount mismatches against anchor documents (or send them to the unplaced report), which I did not do here.
- Caveats: D is a synthetic stress I designed after seeing A, B and C be perfect; 3 runs per variant. The 67/67 figure depends on the dataset having an invoice for every case.

## Files

`build_stress.py`, `group.py`, `compare.py`, `run_reps.py`, `intake_*.json`, `groups_*_r*.json` (each with `unplaced_report`, clusters, shared, attach and cluster logs), `scores.json`, `answer_key.json`.
