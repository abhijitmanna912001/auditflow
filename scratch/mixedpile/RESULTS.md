# Mixed pile: can unlabelled documents be grouped into transactions?

Branch `test/mixedpile` (from `test/atomicity`). Nothing under `agents/`, `dataset/` or ground truth changed. Tracing off. No 401. Full pipeline was **not** run per group (phase 2).

## Method

1. `build_pile.py`: all 67 documents from CASE_01..14 copied byte-for-byte into `pile/doc_001..067.txt` (shuffle seed 20260930). Document text, including the IDs printed inside, is unchanged. The true grouping is in `answer_key.json`, read only by `compare.py`.
2. `run_intake.py`: existing Intake Agent on 7 batch folders (10 files, last 7) named `BATCH_01..07`, so the folder name carries no case ID. `case_id` overwritten with `PILE`. 67 documents came back, 67 unique `doc_id`s (`intake_output.json`).
3. `group.py` (takes only the Intake JSON; no filenames, no answer key):
   - Deterministic pass: union-find over reference tokens. Every doc joins its own `doc_id` and each of its `references`, so a doc citing PO-X joins PO-X's document, and docs citing the same token (a PO with no PO document, a supplier invoice number) still join each other. It does not parse the numeric suffix of IDs.
   - One model call (claude-sonnet-5, same as the agents), only if documents are left alone; it can place each in an existing group or say NEW.
4. `compare.py`: scores against the key.

## Result 1: main run (Intake output as is)

| Metric | Value |
|---|---|
| Documents placed in the correct group | **67 / 67** |
| True cases recovered exactly | **14 / 14** |
| Groups wrongly split | 0 |
| Groups wrongly merged | 0 |
| Predicted groups | 14 (true: 14) |
| Documents needing the model call | 0 (the call was never made) |

Case types the task flagged as hard all came out right:
- **CASE_03, CASE_09 (two invoices for one transaction):** INV-1003-A/B and INV-1009-A/B both cite the same PO, so the reference pass keeps them in one group with the rest of the case (6 and 5 docs). Correct.
- **CASE_05, CASE_11 (no PO):** the invoice, receipt, bank and ledger all cite PO-1005 / PO-1011, which doesn't exist. The shared dangling token still joins them, so they form intact 4-doc groups.
- **CASE_06, CASE_12 (missing receipt):** intact 4-doc groups.
- **Vendor / amount / currency conflicts (CASE_07, 10, 11, 13):** references link them regardless (e.g. PO-1007 names Atlas Facilities Care, the invoice names Orchid Workspace Solutions, still one group).

Caveat that matters: this is an easy test. Nearly every benchmark document cites another document's ID (every invoice cites its PO, every receipt cites PO and invoice), and the benchmark's doc IDs are consistent. A real customer pile will have far weaker cross-references (see Result 2).

## Result 2: ablation (not asked for; run because Result 1 never exercised the model call)

Same pipeline, but references blanked on bank statements and ledger entries (real bank narrations often carry no PO/invoice number). This sends 28 documents through the deterministic pass alone as singletons, and all 28 go to the one model call.

| Metric | Value |
|---|---|
| Documents placed in the correct group | **65 / 67** |
| True cases recovered exactly | 13 / 14 |
| Groups wrongly split | **1** (CASE_11 into 3 groups) |
| Groups wrongly merged | 0 |
| Placed by reference / by model | 39 / 28 |

The model placed 26 of 28 bank/ledger documents correctly, using vendor + amount (+ date). It declined the two it was unsure about, which is the split.

Sensitivity: the model sees `doc_id`s like BNK-1013 next to PO-1013 and could pick up the shared number series. Its stated reasons cite vendor and amount, but I can't prove it didn't use the suffix, so treat 26/28 as an upper bound for real piles.

### Wrong groupings (exact model reasons)

1. **BNK-1011 -> NEW** (true case CASE_11): "Vendor matches Apex Process Systems but amount 129800 INR does not match the 118000 INR figures in G10, so no safe match."
2. **LED-1011 -> NEW** (true case CASE_11): the same reason, word for word.
3. **The two NEW documents were not joined to each other.** BNK-1011 and LED-1011 both show 129800 INR on Apex Process Systems on 2026-08-12, but my prototype makes one group per NEW answer, so they became G15 and G16, two more one-document groups beside G10 (INV-1011 + REC-1011, 118000 INR). This part is a prototype flaw, not a model error.
4. **The cause is the case's own defect.** CASE_11's ground truth is an `amount_mismatch` between the invoice/receipt (118,000) and the bank/ledger (129,800). The grouper treats an amount disagreement as evidence of a different transaction, so **the case types with a planted amount conflict are the hardest to group** once references are missing.

## Which case types are hardest

- Hardest: cases where the amount differs between documents (CASE_11 here). Cases with vendor/date/currency/tax conflicts were fine because vendor+amount on bank/ledger still matched the invoice.
- Two invoices for one transaction (CASE_03, 09): not a problem when both cite the same PO. Not tested where duplicates cite different POs or none.
- Missing PO / receipt cases: fine, because other documents cite the absent one.

## Could an unlinked document cause a false "missing" finding?

Yes, in two ways, both visible in this data (inference from the groups; the pipeline was not run):

1. **Splits.** In the ablation, CASE_11's true group is broken into G10 (invoice + receipt), G15 (lone bank statement) and G16 (lone ledger entry). A per-group Anomaly run would see G10 with no bank/ledger, and G15/G16 with no invoice, PO or receipt, so it would likely raise `missing_po`/`missing_receipt` on the lone documents. Worse, the real `amount_mismatch` disappears, because the mismatching documents are never compared. The grouping error erases a true high-severity finding and adds false ones.
2. **Dangling references are not missing documents.** Unresolved reference tokens in the main run:
   - genuinely missing documents: CASE_05 `PO-1005`, CASE_11 `PO-1011`;
   - supplier invoice numbers that are not documents at all: CASE_03 `SSS/2026/188`, CASE_09 `PIS/2026/091`, CASE_13 `MCS-2026-4471`, CASE_14 `SPS/2026/2208`.

   A rule of "any reference with no matching document means missing" would false-flag 4 of the 6 cases that have dangling references. Any missing-document logic in phase 2 must look only at references shaped like a PO or receipt ID and ignore supplier invoice numbers.

An orphan PO (a PO nobody cites and with no invoice) did not occur in this dataset, so I couldn't test that directly. A lone PO would look like `missing invoice`, which has no finding type, but the pipeline would likely still flag `missing_receipt`.

## Recommendation

Grouping by references looks good enough to proceed to phase 2 **when documents cite each other** (67/67). The risk is piles where bank/ledger documents don't cite references and amounts disagree. Before relying on it:
- merge NEW documents that match each other (fix the prototype);
- make an unassigned lone document a "needs human placement" flag rather than a case of its own, so it can't produce false missing findings;
- test a harder pile (references removed from every type, missing-PO and amount-conflict cases together).

## Files

`build_pile.py`, `run_intake.py`, `group.py`, `compare.py`, `pile/`, `batches/`, `answer_key.json`, `intake_output.json`, `groups_main.json`, `groups_ablation_bank_ledger.json`, `*_score.json`.
