# fix/accuracy results

Change: one sentence added to the Anomaly Agent system prompt (identical in `agents/anomaly_agent.py` and `docs/agent-spec.md`): *A receipt or goods receipt note dated before its invoice is normal procurement practice (goods or services are delivered, then invoiced) and is not a date_inconsistency.*

Method: stage-by-stage (Intake→Evidence→Anomaly→Decision), same runner as the baseline on `test/reliability`; types scored set-wise against ground truth (as `evaluate.score_finding_types`), action exact vs `expected_action`. `evaluation/evaluate.py` unmodified. Baseline = current main before this change (runs saved on `test/reliability`).

## Full benchmark x3 (types match / action match / pass both)

| Case | Before (types/action/both) | After (types/action/both) | Extra / missing after | Changed? |
|---|---|---|---|---|
| CASE_01 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_02 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_03 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_04 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_05 | 0/3, 3/3, 0/3 | 3/3, 3/3, 3/3 | - | yes |
| CASE_06 | 3/3, 3/3, 3/3 | 1/3, 1/3, 1/3 | missing missing_receipt ×2 | yes |
| CASE_07 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_08 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_09 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_10 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_11 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_12 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_13 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | - |  |
| CASE_14 | 1/3, 1/3, 1/3 | 1/3, 1/3, 1/3 | missing tax_mismatch ×2 |  |

## CASE_05: extra date_inconsistency (expected: missing_po only)

| | Extra date_inconsistency |
|---|---|
| Before, 10-run on main (follow-up `new00-09`) | 9/10 |
| Before, 10-run on main (first measurement `run00-09`) | 8/10 |
| Before, benchmark x3 | 3/3 |
| **After, 20 runs** | **0/20** |
| **After, benchmark x3** | **0/3** |


After, 20 runs with exactly missing_po: 20/20; other non-matching runs: none.

## CASE_08: date_inconsistency retained? Ground-truth documents: ['PO-1008', 'INV-1008']

Before (3 baseline benchmark runs): date_inconsistency found in 3/3. After: 10/10 dedicated runs, 3/3 benchmark runs.

Cited documents per run:

| Run | Documents cited by date_inconsistency | Matches ground-truth set |
|---|---|---|
| before bench0 | ['INV-1008', 'PO-1008'] | exact |
| before bench1 | ['INV-1008', 'PO-1008'] | exact |
| before bench2 | ['INV-1008', 'PO-1008'] | exact |
| after fix00 | ['INV-1008', 'PO-1008'] | exact |
| after fix01 | ['INV-1008', 'PO-1008'] | exact |
| after fix02 | ['INV-1008', 'PO-1008'] | exact |
| after fix03 | ['INV-1008', 'PO-1008'] | exact |
| after fix04 | ['INV-1008', 'PO-1008'] | exact |
| after fix05 | ['INV-1008', 'PO-1008'] | exact |
| after fix06 | ['INV-1008', 'PO-1008'] | exact |
| after fix07 | ['INV-1008', 'PO-1008'] | exact |
| after fix08 | ['INV-1008', 'PO-1008'] | exact |
| after fix09 | ['INV-1008', 'PO-1008'] | exact |
| after bench0 | ['INV-1008', 'PO-1008'] | exact |
| after bench1 | ['INV-1008', 'PO-1008'] | exact |
| after bench2 | ['INV-1008', 'PO-1008'] | exact |

Runs that lost date_inconsistency after the change:
 none.

## CASE_10: date_inconsistency retained? Ground-truth documents: ['PO-1010', 'INV-1010', 'BNK-1010']

Before (3 baseline benchmark runs): date_inconsistency found in 3/3. After: 10/10 dedicated runs, 3/3 benchmark runs.

Cited documents per run:

| Run | Documents cited by date_inconsistency | Matches ground-truth set |
|---|---|---|
| before bench0 | ['BNK-1010', 'INV-1010', 'LED-1010', 'REC-1010'] | differs |
| before bench1 | ['BNK-1010', 'INV-1010', 'REC-1010'] | differs |
| before bench2 | ['BNK-1010', 'INV-1010', 'LED-1010', 'REC-1010'] | differs |
| after fix00 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix01 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix02 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix03 | ['BNK-1010', 'INV-1010'] | differs |
| after fix04 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix05 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix06 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix07 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix08 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after fix09 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after bench0 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after bench1 | ['BNK-1010', 'INV-1010', 'LED-1010'] | differs |
| after bench2 | ['BNK-1010', 'INV-1010'] | differs |
| after bench2 | ['INV-1010', 'LED-1010'] | differs |

Runs that lost date_inconsistency after the change:
 none.


## CASE_06 follow-up (unplanned extra check)

The benchmark x3 showed CASE_06 (missing_receipt) dropping from 3/3 to 1/3: in the 2 misses (after bench0, bench2) the **Evidence Agent returned an empty `missing_evidence`**, Anomaly then found nothing, and the Decision Agent auto-cleared a case that should be human_review. To see whether the new sentence caused this, I ran CASE_06 x10 on current main (git worktree of main, removed afterwards) and x10 with the change, concurrently:

| | missing_receipt found | Evidence `missing_evidence` empty | Anomaly still found it when empty |
|---|---|---|---|
| Main, 10 dedicated runs | 10/10 | 1/10 | 1/1 |
| With change, 10 dedicated runs | 10/10 | 0/10 | - |
| Benchmark x3 before (baseline saved on `test/reliability`) | 3/3 | 1/3 | 1/1 |
| Benchmark x3 after | 1/3 | 2/3 | 0/2 |

Totals: main 13/13, with change 11/13 (20 runs dedicated+bench, 2 misses, both in the benchmark batch). That is not a statistically meaningful difference, and the upstream cause (Evidence sometimes not reporting a missing receipt) is in an agent this change doesn't touch. But the two benchmark misses are the only cases where Anomaly, given an empty `missing_evidence`, did not notice the absent receipt itself, which happened once in 1/1 on main; the sample is too small to say whether the new sentence makes Anomaly slightly less willing to infer a missing receipt. Not fixed; flagging for a larger CASE_06 sample if you want certainty.

## Notes

- **CASE_10 documents:** ground truth lists `PO-1010, INV-1010, BNK-1010`. Neither before nor after did any run cite that exact set (scoring is by type only). Before: BNK/INV + REC and usually LED. After: BNK/INV + LED (2 of 16 runs cite only BNK/INV or INV/LED). REC-1010 (the receipt, dated before its invoice) was cited in all 3 baseline runs and in 0 of 16 after runs, which is the intended effect of the rule; PO-1010 was not cited in any run either way. One run (after bench2) produced two separate date_inconsistency findings.
- **CASE_08:** cited documents are exactly the ground-truth set in every run, before and after (20/20 incl. baseline).
- CASE_14 (tax_mismatch) is unchanged at 1/3 and is a separate issue.
- No run in CASE_05 (23 runs after the change) raised an extra date_inconsistency, so there is nothing to quote there.
