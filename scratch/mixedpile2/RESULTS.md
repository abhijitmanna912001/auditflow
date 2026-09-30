# Mixed pile 2: grouping without ID leakage

Branch `test/mixedpile2` (from `test/mixedpile`). No agent, prompt, dataset or ground-truth file changed. Tracing off, no 401. Full pipeline not run.

## What changed vs mixedpile 1

- **Re-keyed IDs** (`build_pile.py`): all 69 document IDs found anywhere in the 14 cases (including PO-1005 and PO-1011, cited but never present) got a fresh random 5-digit number, replaced consistently in every text. No number is shared across types or cases; `-A`/`-B` suffixes are gone. Citations still match the real documents. A grep confirms no `10xx` series remains in any file. The key is in `answer_key.json`, read only by `compare.py`.
- **Prototype v2** (`group.py`): deterministic reference pass, then one model call for lone documents. The model may only attach a document to an existing group or answer NONE. NONE, or an omitted document, goes to an `unplaced` list. Unplaced documents never form a case of their own and are never merged with each other.
- **Intake** (existing agent, batches of 10 with neutral folder names; `case_id` set to `PILE`): 67 core documents, 3 distractors, 1 multi-payment statement.
- **Variants** (`run_variants.py`, blanking done on the Intake output):
  - **A**: references as extracted.
  - **B**: references blanked on bank statements, ledger entries and receipts (invoices keep their PO reference).
  - **C**: B plus 3 distractors: two extra Horizon Office Systems invoices (46,905 and 47,495 INR vs CASE_01's 47,200; each cites a PO that is not in the pile) and one CloudDesk PO (93,220 INR vs CASE_02's 94,400) that no invoice cites.
  - Each variant is run without ("A") and with ("A_M") the multi-payment statement, so its effect is isolated.

## Numbers (67 real documents, 14 real cases)

| Variant | Correct | Placed wrong | Unplaced | Wrongly split | Wrongly merged | Model call |
|---|---|---|---|---|---|---|
| **A** | **67** | 0 | 0 | 0 | 0 | none needed |
| **B** | **59** | 0 | 8 | 0 | 0 | 41 lone docs: 33 placed, 8 unplaced |
| **C** | **59** | 0 | 8 (+3 distractors) | 0 | 0 | 44 lone docs |
| A + multi-payment | 52 | **15** | 0 | 0 | **1 group (4 cases)** | none |
| B + multi-payment | 59 | 0 | 8 (+ the statement) | 0 | 0 | |
| C + multi-payment | 59 | 0 | 8 (+ 3 distractors + statement) | 0 | 0 | |

**Correct placement in B and C: every one of the 33 model placements was right**, using vendor, amount and date with no ID leakage. **All 8 unplaced real documents are the two missing-PO cases** (CASE_05 and CASE_11, 4 documents each), unplaced together.

**Distractors (C):** all three were left unplaced, none absorbed into a real group. Caveat: distractors can only be attached to a real group (they are lone documents), so the trap of pulling CASE_01's bank/ledger documents toward a lookalike invoice is not exercised in this design. In addition, the distractor invoices kept their PO references, and the model used them: "Vendor Horizon Office Systems but references PO-44324 (not matching G02's PO-92645) and a different amount, indicating a separate transaction." Distractor invoices with blanked references would be a harder test and were not run.

**Splits:** none in any variant, so no split-caused false missing finding. Cases with a receipt or PO absent from the best group (false-missing exposure): none. Groups that would be wrong to analyse: the A+multi-payment merged group (below), and the 8 unplaced documents, which get no analysis at all.

## Multi-payment bank statement (BNK-78056, four payments across four cases)

**What Intake extracted:** a single object with `vendor: "AuditFlow Operations"` (the account holder, not a beneficiary), `amount: null`, `date: null`, `currency: INR`, and all 8 citations in `references`: INV-13513, PO-15226, INV-63147, PO-92645, INV-93865, PO-75791, INV-68290, PO-77099. The four payments survive only in `extraction_notes`: "Statement contains 4 separate payment transactions (2026-07-10, 2026-07-25, 2026-09-01, 2026-09-03) to different beneficiaries with different amounts; a single amount/date/vendor cannot be assigned to the whole document. Amounts per transaction: INR 82,500.00 (Vertex Print Solutions), INR 47,200.00 (Horizon Office Systems), INR 94,400.00 (CloudDesk Software India), INR 106,200.00 (BluePeak Training Services)." Intake flagged the problem honestly; it just has no schema slot for it.

**How grouping treats it:**
- With references kept (A): the reference pass follows its 8 citations and **fuses four separate cases into one 21-document group** (CASE_01, 02, 04 and 08, 20 documents plus the statement). 15 real documents are counted wrong under a majority-case scoring. An Anomaly run on that group would compare four vendors' invoices against each other, so I'd expect spurious duplicate/amount/vendor findings and the loss of four separate verdicts (inference; not run).
- With references blanked (B, C): it reaches the model as a lone document, and the model refused it: "This statement bundles four separate payments to different vendors/groups (G02, G08, G09, G11) and cannot be assigned to a single transaction group." It lands in `unplaced`, and the four cases are unaffected because each still has its own bank statement.

## Examples of wrong groupings (quoted)

1. **Merge from the multi-payment statement (A + M):** the reference pass has no notion of a document that legitimately belongs to several transactions. Group G02 contains `BNK-78056` plus the PO/invoice/receipt/bank/ledger documents of CASE_01, 02, 04 and 08 (e.g. INV-63147, INV-13513, INV-93865, INV-68290).
2. **CASE_05 documents unplaced (B, C):** `BNK-33247`: "Vendor GreenRoute Logistics Pvt. Ltd. has no existing group in the batch to match against." The same sentence is given for `INV-90387`, `REC-20048` and `LED-55770`.
3. **CASE_11 documents unplaced (B, C):** `INV-33619`: "Vendor Apex Process Systems Pvt. Ltd. has no existing group to match against." Same for `BNK-29140`, `LED-61696`, `REC-15268`. The reason is structural: with no PO, no document forms a group to attach to, and the rule forbids merging unmatched documents with each other.
4. **Consequence of 2 and 3:** CASE_05 (planted `missing_po`) and CASE_11 (`missing_po` + `amount_mismatch`) are two of the cases with real findings, and both fall out of the pipeline entirely. This would be a silent miss unless unplaced documents are surfaced to a person. Human placement of 8 documents is cheap, but nothing here prevents those cases being ignored.

No case was split and no real document was misplaced into another case's group in B or C.

## Conclusions

- Removing the ID series did not hurt: variant A is still 67/67, because it relies on citations, not number patterns. Mixedpile 1's easy result was not caused by the ID numbering.
- Blanking references on receipts, bank and ledger (B) cost nothing in accuracy but 8 documents were unplaced; no wrong placements.
- The two real dangers are (a) a multi-payment document fusing cases when references are followed, and (b) missing-PO cases having no anchor and disappearing into `unplaced`. Neither was fixed here, as instructed.
- Caveats: the model still sees vendor, amount and date agreement, which are rich in this synthetic dataset (each bank/ledger amount equals the invoice total). Real piles with partial payments, bank fees or FX will be harder. One run per variant, so no variance estimate.

## Files

`build_pile.py`, `run_intake.py`, `run_variants.py`, `group.py`, `compare.py`, `pile/`, `extras/`, `batches/`, `answer_key.json`, `intake_*.json`, `groups_*.json`, `groups_*_score.json`.
