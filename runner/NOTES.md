# runner/: vendor-independent audit run skeleton

Reads documents from a **Source**, groups them into transactions, runs the existing five-agent pipeline per group, and creates **one ticket per finding** in a **TicketSink**. Nothing under `agents/`, `orchestration/`, `dataset/`, `docs/`, `evaluation/` or `frontend/` was changed, and `requirements.txt` is untouched.

## How to run

```bash
set -a; source .env; set +a          # ANTHROPIC_API_KEY into the environment (never written to a file or log)
unset NEATLOGS_API_KEY               # tracing off
python -m runner.run --source <folder of PDFs/images> --out <output folder>
```

Output folder: `tickets/<finding_id>.json` (+ `tickets/<finding_id>/attachments/`), `runs/<run_id>/run_record.json`, `runs/<run_id>/unplaced_report.json`. Running the same folder again into the same `--out` creates no duplicate tickets. Supported files: PDF, PNG, JPG, WEBP (what the Intake upload path accepts); other files go to the unplaced report.

Offline tests: `python -m pytest runner/tests -q` (no API calls). Test-only packages installed in the venv, **not** in requirements.txt: `reportlab` (PDF fixtures, `runner/tools/make_test_pile.py`) and `pytest`.

## Modules

| Module | Role |
|---|---|
| `source.py` | `Source` (abstract: `list_files()`, `read_file()`), `LocalFolderSource`. **Slot 1.** |
| `sink.py` | `TicketSink` (abstract: `find_existing(finding_id)`, `create_ticket(title, body, attachments, finding_id)`), `LocalTicketSink` (JSON + copied attachments). **Slot 2.** |
| `grouping.py` | Groups Intake documents. Invoices, POs and receipts anchor groups; bank/ledger documents attach by reference or by model on vendor/amount/date; documents linked to several groups are shared and never join groups; **amount rule** (a document attaches only if its amount equals an anchor amount, or it states no amount and a reference links it); unplaced documents can be clustered as hints. Groups without an invoice (e.g. a PO nobody cites) are reported, not analysed. |
| `pipeline.py` | Adapter: Intake per file (so each document is tied to its file) and `run_full_pipeline_from_documents` per group, capturing the Decision Agent's per-finding output (see limitation 1). |
| `tickets.py` | Stable finding id (type + SHA-256 of the cited files' bytes), ticket title and body with the fact-check wording. |
| `run.py` | Run manager and CLI: read, Intake, group, pipeline per group, tickets, run record, unplaced report. |

The run record holds run id, status, files processed, groups, findings, tickets created (and pre-existing), clean groups, unplaced documents and errors. Logs contain ids and counts only, and error records contain the exception type and HTTP status, never text. Nothing else is kept after a run.

## Test results (24 PDFs from CASE_01, 05, 09, 13, 14, shuffled, neutral names)

Grouping: 5 groups, exactly the 5 cases; 0 unplaced; the 2 runs completed with no errors. Run 2 created **0 new tickets** (6 already existing).

| Case | Expected | Got | Match |
|---|---|---|---|
| CASE_01 | no ticket | none | yes |
| CASE_05 | missing_po | missing_po (2 files: INV, REC) **plus** date_inconsistency (REC dated 2026-07-18, three days before the invoice) | extra ticket |
| CASE_09 | duplicate_invoice, amount_mismatch, missing_receipt | all three | ticket count yes; missing_receipt ticket has **no attachments** (see below) |
| CASE_13 | currency_mismatch | currency_mismatch, 4 attachments (INV, PO, BNK, LED) | yes |
| CASE_14 | tax_mismatch | **none** (group auto-cleared) | **missed** |

What did not match:
- **CASE_14 tax_mismatch missed.** The invoice reads 200,000 + 36,000 GST = 246,000 (should be 236,000). This is an agent miss, not a runner one: `run_full_pipeline` on the original `.txt` folder also returned Clean/auto_clear in 2 of 2 runs.
- **CASE_05 extra `date_inconsistency` ticket** (not in the ground truth). It is the Anomaly Agent's output, and its attachments were right (the 2 cited files).
- **CASE_09 `missing_receipt` ticket carries no attachments.** The Anomaly Agent cited an empty document list ("No goods receipt note ... exists anywhere in the transaction ..."), so the ticket title reads `[(none)]` and the body lists no documents. The ground truth lists the present documents for this type. A fallback that attaches the group's documents when a finding cites none is not implemented.
- **No ticket carried a wrong attachment.** All attachments of the other 5 tickets belong to the ticket's case and match the documents each finding cites (checked against the answer key, kept outside the repo).

## Limitations and follow-ups

1. **Per-finding data is captured by wrapping** `run_decision_agent` and `run_intake_agent_from_documents` inside `workpaper_agent` for the call, because `run_full_pipeline_from_documents` returns only the workpaper, which merges findings into one row. Not thread-safe (groups run one at a time). Cleaner fix: have the agent layer return findings.
2. **Idempotency depends on the agents citing the same documents.** The finding id hashes the type and the cited files. Both runs here matched, but earlier atomicity tests showed the cited-document set varying between runs for the same fact (e.g. CASE_91). A varying set produces a new id and a duplicate ticket. Options: build the id from type + the group's anchor documents for missing_* types.
3. **Intake runs twice** per file (once per file for grouping, once inside the group's pipeline). Doubles Intake cost; the pipeline function offers no way to pass extracted documents in.
4. **The amount rule sends genuinely mismatching bank/ledger documents to the unplaced report.** A CASE_11-style amount_mismatch (invoice 118,000 vs bank 129,800) would be reported as unplaced, not as a finding. Nothing here creates a finding for an unplaced document.
5. Duplicate document ids across files: the second goes to the unplaced report. A file with several documents is supported (documents map to the same file).
6. The multi-payment statement is shared across groups by reference (tested in mixedpile3), so its file is passed to each group's pipeline run; the pipeline itself has no notion of a shared document.

## Still needed for a real connector

- **Auth:** credentials come from the environment or a secret manager only; never logged. OAuth refresh and token expiry for Drive/SharePoint-type sources; API token scopes for the ticket tool (create + read only). Decide how per-tenant credentials are stored.
- **Rate limits:** the Anthropic API (Intake runs 4 files in parallel; a large folder needs a shared limiter and retry with backoff on 429/5xx, which is not implemented) and the storage/ticket APIs (paging of `list_files`, backoff on `create_ticket`, and a per-run cap on tickets created).
- **Attachment size limits:** ticket tools cap attachments (often 10-25 MB per file); Intake sends whole files, and Anthropic PDFs have their own size and page limits. Large or over-limit files need to be rejected into the unplaced report with a reason (only the file type is checked now).
- **Idempotency in the remote system:** `find_existing` must search the ticket tool by a finding-id label or custom field, not by title.
- **Partial failure:** `create_ticket` followed by a failed attachment upload needs cleanup or a retry that does not duplicate. Runs are also not resumable yet.
- **Concurrency:** two runs over the same source at once can both miss `find_existing`; a per-source lock or a create-if-absent call in the sink is needed.
- **Privacy:** ticket bodies contain vendor names and amounts, and attachments are copies of the documents; the destination's access controls must suit that. The run record and unplaced report hold file names and document ids only.
