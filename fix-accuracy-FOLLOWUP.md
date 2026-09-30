# fix/accuracy follow-up: does the new Anomaly sentence weaken missing-receipt detection?

No agent code, prompts, dataset files, ground truth or `evaluate.py` changed. Data is in the session scratchpad (not committed). Old prompt = `main` (worktree of 800c283, confirmed not to contain the new sentence); new prompt = `fix/accuracy`. Worktree removed afterwards.

## Part 1: the empty-`missing_evidence` runs from the last measurement

Saved run data was still available.

| Run | Code | Evidence `missing_evidence` | Anomaly found missing_receipt? |
|---|---|---|---|
| CASE_06 benchmark run 0 | with the change | empty | **No** (no findings; Decision auto_clear) |
| CASE_06 benchmark run 2 | with the change | empty | **No** (no findings; Decision auto_clear) |
| CASE_06 main run `main08` | main (old prompt) | empty | **Yes** |
| CASE_06 baseline benchmark run 2 (saved on `test/reliability`) | main (old prompt) | empty | **Yes** |

So 0/2 with the change vs 2/2 on main. But these are different Evidence outputs, so Part 2 holds the input fixed.

## Part 2: paired Anomaly-only test (same input, old vs new prompt)

Inputs: Intake documents plus one Evidence output with `missing_evidence: []`. Only Anomaly was called. Note: Anomaly's output schema has `findings` only, so a run that finds nothing has no explanation to quote; instead I quote what the Evidence notes say about the receipt, since that is all Anomaly has to go on.

| Input | Real / synthetic | Old prompt: found missing_receipt | New prompt: found missing_receipt |
|---|---|---|---|
| CASE_06, real empty-evidence output A (from the benchmark run) | **real** | **0/20** | **1/20** |
| CASE_12, real Evidence output with `missing_evidence` set to `[]` | **synthetic** | 20/20 | 20/20 |
| CASE_06 real empty B (benchmark run 2) [supplemental, 5 runs each] | real | 0/5 | 0/5 |
| CASE_06 real empty C (main08) [supplemental] | real | 4/5 | 4/5 |
| CASE_06 real empty D (baseline bench 2) [supplemental] | real | 5/5 | 5/5 |
| CASE_06 real empty E (from Part 3) [supplemental] | real | 0/5 | 0/5 |

The 80 requested calls are the first two rows (20 each per version); the four supplemental CASE_06 rows (40 more calls) were added because no real empty CASE_12 output exists (see Part 3).

What this shows:
- **No evidence that the new sentence weakens detection.** On every input, old and new give the same result, within one run (A: 0 vs 1 of 20). The old prompt fails equally on A, B and E, so those failures predate the change.
- **What decides the outcome is what the Evidence notes say, not the prompt.** Where the notes explicitly record that no receipt/delivery document is present (C, D), Anomaly catches it in 9/10 for both versions. Where the notes do not raise the absence (A, B, E), Anomaly finds nothing in both versions (0/30 old, 1/30 new). Examples of the notes' receipt sentence:
  - A (missed): "absent any separate receipt or delivery confirmation document, does not itself establish fulfillment of any payment-terms conditions..."
  - B (missed): "No additional supporting document type (e.g., a separate goods receipt or payment confirmation) is implied by the pattern of documents in this case, so no evidence is treated as missing."
  - E (missed): "No goods-receipt or delivery-confirmation document was provided or referenced by any record in this case, so its necessity cannot be inferred and is not flagged as missing evidence."
  - C (caught 4/5 both): "No delivery/goods-receipt document is present in this case, but nothing... establishes that such a document is a standard requirement... so its absence is not flagged as missing evidence - only noted as an unconfirmed step."
- **CASE_12 row is weak evidence.** It is synthetic: only `missing_evidence` was emptied, and the original notes still say a signed service acceptance receipt is required by the PO and invoice and was not provided. Both versions catch it 20/20 because the notes spell it out. It shows the new sentence doesn't interfere when the absence is explicit, but it is not a realistic empty-Evidence case. No real empty CASE_12 output exists (Part 3).
- Caveat: the old prompt has never been observed to catch A/B/E either, so the CASE_06 benchmark drop from 3/3 to 1/3 is explained by more empty Evidence outputs in that batch, not by the prompt. The difference between 13/13 and 11/13 earlier is consistent with Evidence variance.

## Part 3: Evidence base rate (Evidence stage only, code unchanged)

Fixed Intake input per case (saved Intake output reused, so only Evidence varies).

| Case | Runs | `missing_evidence` empty | evidence_confidence, empty runs | evidence_confidence, non-empty runs |
|---|---|---|---|---|
| CASE_06 | 30 | **1/30 (3%)** | 0.90 | mean 0.76 (range 0.70-0.85, 29 runs) |
| CASE_12 | 20 | **0/20** | - | mean 0.57 (range 0.50-0.62, 20 runs) |

Pooling every CASE_06 Evidence output collected in this investigation (Evidence is not affected by the Anomaly prompt): 5 empty of 56 runs (about 9%). All 5 empty runs had evidence_confidence of 0.90-0.94, above the highest non-empty run (0.85 in Part 3). So an empty `missing_evidence` comes with unusually high Evidence confidence, which means a confidence threshold would not catch these cases.

## Summary

1. The Anomaly sentence did not measurably change missing-receipt detection when Evidence reported nothing missing (old 0/20 vs new 1/20 on the real CASE_06 input; identical elsewhere).
2. The failure is in Evidence: about 3-9% of CASE_06 runs report nothing missing, with high confidence, and Anomaly then follows Evidence unless the notes spell out the missing receipt.
3. Not fixed, as instructed.
