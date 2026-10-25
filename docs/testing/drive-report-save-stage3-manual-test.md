# Stage 3 manual test: Save to Google Drive

Manual end-to-end check of the Save to Google Drive feature on branch
`feature/drive-report-save-stage3`, with a real Google account and real
backend runs. Automated test results are recorded separately below and do not
count as manual results.

Status values: **Not run**, **Pass**, **Fail**, **Blocked**. A test is marked
Pass only when the tester saw the expected result. Record what was actually
seen in Observations, including anything unexpected.

## Test run details

| Field | Value |
| --- | --- |
| Tester | |
| Date | |
| Commit tested | |
| Browser and version | |
| Operating system | |
| Google account used (a listed OAuth test user) | |
| Backend (local `uvicorn` or deployed URL) | |
| Frontend URL | `http://localhost:3000` (the origin registered for the OAuth client) |
| Time zone of the browser | |

## Before you start

1. Check out the commit under test and install the frontend dependencies
   (`npm --prefix frontend ci`).
2. In `frontend/.env.local`, set `NEXT_PUBLIC_GOOGLE_CLIENT_ID`,
   `NEXT_PUBLIC_GOOGLE_API_KEY` and `NEXT_PUBLIC_GOOGLE_APP_ID`. This is the
   existing Drive feature flag: with any of them empty, no Drive control
   appears at all.
3. Start the backend and the frontend as described in the README under
   "Run locally". A backend run calls the model, so each run has a cost.
4. If the deployment asks for an access code, enter it as usual. Saving to
   Drive does not use the access code.
5. Use a Google account listed as a test user on the OAuth consent screen.
   In Testing mode Google asks for consent again about seven days after the
   last consent (see `docs/research/google-drive-oauth-public-access.md`).
6. Note: with the `drive.file` scope AuditFlow only sees folders it created
   itself. If the account already has an `AuditFlow` folder made by hand,
   AuditFlow creates a separate `AuditFlow` folder next to it. That is
   expected, not a failure.

Dates in folder and file names use the browser's local time at the moment
the run completed. `YYYY-MM` below means that month.

## A. Google Drive connection

| ID | Step | Expected result | Status | Observations |
| --- | --- | --- | --- | --- |
| A1 | Open the app. Do not connect Drive. | "Connect Google Drive" shows in the header. No "Save to Google Drive" button anywhere. | Not run | |
| A2 | Complete a sample run (any case) while Drive is disconnected. | Results show with "Save PDF report". "Save to Google Drive" is still hidden. | Not run | |
| A3 | Click "Connect Google Drive" and sign in with the test account. Grant access. | Google's window opens from the click (not blocked). After consent the header button reads "Disconnect Google Drive". No success pop-up message. | Not run | |
| A4 | With the completed run from A2 still on screen, look at the results header. | "Save to Google Drive" now shows next to "Save PDF report", with the hint "Saves the PDF report to the AuditFlow folder in your Google Drive." | Not run | |
| A5 | Connect, but untick the Drive permission on Google's consent screen. | Message: "Google Drive access wasn't allowed, so AuditFlow can't use Drive." Drive stays disconnected and the save button stays hidden. | Not run | |
| A6 | Close Google's window without signing in. | Message: "Google Drive wasn't connected." | Not run | |

## B. Case 14 sample report

| ID | Step | Expected result | Status | Observations |
| --- | --- | --- | --- | --- |
| B1 | Choose "Case 14 — Transaction 14 · Tax mismatch" and run the check. | The run completes with real results (no "Showing sample results" warning). The finding is a tax calculation mismatch on INV-1014. | Not run | |
| B2 | Click "Save to Google Drive". | While saving the button is disabled and reads "Saving to Google Drive…". | Not run | |
| B3 | Wait for the save to finish. | Green message: `Saved to Google Drive as “AuditFlow_Report_Case-14_YYYY-MM-DD_HHmmss.pdf” in My Drive › AuditFlow › No company named › YYYY-MM.` Record the exact name shown. | Not run | |
| B4 | Open Google Drive in the browser. | The file is at `My Drive / AuditFlow / No company named / YYYY-MM /` with exactly the name shown in B3. | Not run | |
| B5 | Open the PDF in Drive's viewer and download it. | It opens as a PDF (not HTML). Company: "No company named". Case: "Case 14 (CASE_14)". | Not run | |
| B6 | Check the Documents section of the PDF. | Lists all five: `BNK-1014.txt`, `INV-1014.txt`, `LED-1014.txt`, `PO-1014.txt`, `REC-1014.txt`, with no extra separate `INV-1014` entry. | Not run | |
| B7 | Check the Findings section. | One finding, "Tax calculation mismatch". Main document and Related documents are both `INV-1014`. The note "Confidence is for reference." is present. No severity is shown. | Not run | |
| B8 | Select and copy text from the PDF (for example "finding", "Confidence", "qualified"). | Copied text is intact, with no missing letters after "f". | Not run | |
| B9 | Check the PDF for anything that shouldn't be there, including the viewer's attachments panel. | No access code and no Google access token anywhere in the PDF. The source documents are identified by file name only: none is embedded or attached, and no raw document text is reproduced (for example the invoice's line items, "Bill To" line or payment terms). Figures in a finding's explanation are allowed where they explain the finding, such as Case 14's subtotal, tax and total. | Not run | |

## C. Name collision

| ID | Step | Expected result | Status | Observations |
| --- | --- | --- | --- | --- |
| C1 | With the same completed Case 14 run on screen, click "Save to Google Drive" again. | Message names a new file: `AuditFlow_Report_Case-14_YYYY-MM-DD_HHmmss (2).pdf`, same folder. | Not run | |
| C2 | Look at the folder in Drive. | Both files are there. The first file from B3 is unchanged (same size, same modified time, still opens). | Not run | |
| C3 | Save a third time. | The new file is named `… (3).pdf`. | Not run | |
| C4 | Double-click or click repeatedly on "Save to Google Drive" quickly. | Only one new file is created for that click burst; the button is disabled while saving. | Not run | |

## D. Uploaded documents

| ID | Step | Expected result | Status | Observations |
| --- | --- | --- | --- | --- |
| D1 | Choose "Your uploaded documents", add some PDF or image files with "Upload documents" (for example a local copy of the Case 14 documents as PDFs), and run the check. | The run completes with "Results from your documents". | Not run | |
| D2 | Type a company name in "Company name" (try one with an accent, for example `Société Générale Müller`). | The field accepts it. | Not run | |
| D3 | Click "Save to Google Drive". | Message: `Saved to Google Drive as “AuditFlow_Report_Uploaded-documents_YYYY-MM-DD_HHmmss.pdf” in My Drive › AuditFlow › <company name> › YYYY-MM.` | Not run | |
| D4 | Open the folder in Drive. | The company folder has exactly the name typed (slashes would appear as hyphens). | Not run | |
| D5 | Open the PDF. | Company shows the typed name with accents intact. The Documents table lists each uploaded file name with the document ID it was read as ("Read as"). Case reads "Not applicable (uploaded documents)". | Not run | |
| D6 | Clear the company name and save again. | Saved under `AuditFlow / No company named / YYYY-MM`. | Not run | |

## E. Existing behaviour and failures

| ID | Step | Expected result | Status | Observations |
| --- | --- | --- | --- | --- |
| E1 | After a completed run, click "Save PDF report". | The browser's print window opens, as before. Choosing "Save as PDF" saves the print version of the report. Nothing is sent to Drive. | Not run | |
| E2 | Click "Disconnect Google Drive" and confirm in AuditFlow's dialog. | Drive disconnects, "Save to Google Drive" disappears. | Not run | |
| E3 | Reconnect, then disconnect while a save is in progress (start a save, then disconnect at once). | The save never reports success. Expected one of: "Google Drive was disconnected, so the report wasn't saved." or an amber "Upload not confirmed. AuditFlow can't tell whether the report was saved: Google Drive was disconnected before AuditFlow could confirm it. Look for “…” in My Drive › … before saving again." Check Drive and record whether a file was created. | Not run | |
| E4 | Go offline (browser dev tools, Network: Offline) and click "Save to Google Drive". | A failure message such as "The report couldn't be saved because of a connection problem. Try again." No success message. No file appears in Drive after going back online. | Not run | |
| E5 | Revoke AuditFlow's access at https://myaccount.google.com/connections while connected, then save. | "Google Drive access expired. Reconnect Google Drive and save again." The header button changes to "Reconnect Google Drive" and the save button hides. | Not run | |
| E6 | In the browser's dev tools, check the network requests made while saving. | Requests go only to `www.googleapis.com`. None go to the AuditFlow backend, none carry `X-Access-Code`, and no URL contains the access token. | Not run | |
| E7 | Check that nothing was stored: in dev tools, look at Local Storage, Session Storage and Cookies for the site. | No Google token or Drive folder ID is stored. (The Company name and access code may be in Session Storage, as before.) | Not run | |

## Issues found

| # | Test ID | What happened | Severity | Reported to |
| --- | --- | --- | --- | --- |
| | | | | |

## Automated tests (recorded separately)

These were run locally on Windows with a mocked Google Drive API and do not
replace the manual tests above.

| Commit | Command | Result |
| --- | --- | --- |
| `13e0230` | `npm --prefix frontend test` | 403 of 403 passed (10 test files) |
| `13e0230` | `npm --prefix frontend run typecheck` | Passed |
| `13e0230` | `npm --prefix frontend run build` | Passed |
| `13e0230` | `npm --prefix frontend audit` | 0 vulnerabilities |

The automated tests cover, with a fake Drive API: folder lookup and
creation, name collisions, no overwrites, uncertain-upload recovery, token
and disconnect handling, request security, Case 14's five source files in
the uploaded PDF, every sample case's file list, and that the Save PDF
report button is unchanged. They do not exercise real Google sign-in,
real Drive storage or a real browser.
