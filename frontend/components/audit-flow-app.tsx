"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  fetchWorkpaper,
  fetchWorkpaperFromUpload,
  workpaperPayloadFallback,
} from "../lib/mock-workpaper";
import {
  ambiguousNotice,
  safeTicketUrl,
  sendFinding,
  summarizeRun,
  ticketLabel,
  unmappedNotice,
  type SendStatus,
} from "../lib/zoho-desk";
import {
  checkLocalFiles,
  cleanUpAfterDisconnect,
  isCurrentRun,
  startRun,
  summarizeSelection,
  type ImportedFile,
  type SelectionSummary,
} from "../lib/drive-files";
import { getDriveSession, isDriveConfigured } from "../lib/google-drive";
import {
  finishedRunState,
  resolveStageState,
  showsResults,
  stageStateLabel,
  type RunState,
} from "../lib/run-progress";
import { AccessCodeControl } from "./access-code-control";
import { DriveConnectButton, DriveConnectMessages } from "./drive-connect-button";
import {
  DRIVE_SAVE_HINT,
  DRIVE_SAVE_HINT_ID,
  DriveSaveAction,
  DriveSaveStatus,
  showsDriveSaveAction,
  showsDriveSaveStatus,
  useDriveSave,
} from "./drive-save-button";
import { ResultsActions, SAVE_PDF_HINT_ID } from "./results-actions";
import {
  DriveFilePicker,
  driveSelectHint,
  useDriveState,
} from "./drive-file-picker";
import {
  actionLabel,
  caseDisplayName,
  findingLabel,
  matchedDocuments,
  resolverSummary,
} from "../lib/display-labels";
import type {
  Confidence,
  EvidenceResolution,
  FindingDetail,
  Workpaper,
  WorkpaperRow,
} from "../types/workpaper";
import { Icon } from "./icons";
import { PrintReport } from "./print-report";


interface AuditCase {
  id: `CASE_${string}`;
  name: string;
  detail: string;
}

interface Stage {
  name: string;
  description: string;
  icon: string;
}

interface CompletedRun {
  readonly completedAt: Date;
  readonly uploadedFileCount: number;
}

interface ExceptionDetail {
  reason: string;
  severity: "None" | "High";
}

const stages: Stage[] = [
  {
    name: "Read",
    description: "Identify each invoice, PO, receipt and payment record",
    icon: "↓",
  },
  {
    name: "Match",
    description: "Link each invoice to its PO, receipt and payment",
    icon: "⌘",
  },
  {
    name: "Check",
    description: "Compare amounts, suppliers, dates and tax; note missing documents",
    icon: "⌁",
  },
  { name: "Route", description: "Send any finding for review", icon: "✓" },
  {
    name: "Report",
    description: "List findings and the documents behind them",
    icon: "▤",
  },
];

const cases = [
  {
    id: "CASE_01",
    name: "Transaction 01 · No expected findings",
    detail: "Expected result: no findings",
  },
  {
    id: "CASE_02",
    name: "Transaction 02 · No expected findings",
    detail: "Expected result: no findings",
  },
  {
    id: "CASE_03",
    name: "Transaction 03 · Duplicate invoice",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_04",
    name: "Transaction 04 · Amount mismatch",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_05",
    name: "Transaction 05 · Missing PO",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_06",
    name: "Transaction 06 · Missing receipt",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_07",
    name: "Transaction 07 · Vendor mismatch",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_08",
    name: "Transaction 08 · Date inconsistency",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_09",
    name: "Transaction 09 · Duplicate invoice, amount mismatch, missing receipt",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_10",
    name: "Transaction 10 · Vendor mismatch, date inconsistency",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_11",
    name: "Transaction 11 · Missing PO, amount mismatch",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_12",
    name: "Transaction 12 · Missing receipt",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_13",
    name: "Transaction 13 · Currency mismatch",
    detail: "Expected result: needs review",
  },
  {
    id: "CASE_14",
    name: "Transaction 14 · Tax mismatch",
    detail: "Expected result: needs review",
  },
] as const satisfies readonly AuditCase[];

type BenchmarkCaseId = (typeof cases)[number]["id"];
type CaseId = BenchmarkCaseId | "UPLOAD";

const detailByDocument: Record<string, ExceptionDetail> = {
  "INV-1001": {
    reason:
      "The PO, receipt and bank record agree with the invoice on supplier, date and amount.",
    severity: "None",
  },
  "INV-1004": {
    reason:
      "Invoice total is INR 82,500.00; the purchase order total is INR 75,000.00. The receipt, bank record and ledger agree with the invoice.",
    severity: "High",
  },
  "INV-1006": {
    reason: "No signed goods or service receipt was found for this payment.",
    severity: "High",
  },
  "INV-1007": {
    reason:
      "The supplier name differs between the purchase order and the invoice; the other documents don't show which supplier name is correct.",
    severity: "High",
  },
};

const COMPANY_STORAGE_KEY = "auditflow-company-name";
const COMPANY_MAX_LENGTH = 120;
const SAMPLE_SEND_TOOLTIP = "Upload your own documents to send to Zoho Desk.";

function readStoredCompany(): string {
  try {
    return window.sessionStorage.getItem(COMPANY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeCompany(value: string): void {
  try {
    window.sessionStorage.setItem(COMPANY_STORAGE_KEY, value);
  } catch {
    // Storage unavailable: the name just isn't remembered.
  }
}

// Nothing on the page depends on the access code any more.
function ignoreAccessCodeChange(): void {}

function isTicketed(status: SendStatus | undefined): boolean {
  return status?.state === "created" || status?.state === "duplicate";
}

const formatConfidence = (value: Confidence) => `${Math.round(value * 100)}%`;

export function AuditFlowApp() {
  const [selectedCase, setSelectedCase] = useState<CaseId>(cases[0].id);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  // Which of the uploaded files came from Google Drive, by Drive file id.
  // Kept in memory to spot repeats; the ids are never sent anywhere.
  const [driveIds] = useState(() => new WeakMap<File, string>());
  const [driveBusy, setDriveBusy] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] =
    useState<SelectionSummary | null>(null);
  const driveState = useDriveState();
  const driveConfigured = isDriveConfigured();
  const [useResolver, setUseResolver] = useState(false);
  const [runState, setRunState] = useState<RunState>("ready");
  const [activeStage, setActiveStage] = useState(-1);
  const [selectedRow, setSelectedRow] = useState<WorkpaperRow | null>(null);
  const [uploadSnapshot, setUploadSnapshot] = useState<readonly File[] | null>(
    null,
  );
  const [company, setCompany] = useState("");
  const [companyMissing, setCompanyMissing] = useState(false);
  const [sendStatuses, setSendStatuses] = useState<
    Partial<Record<string, SendStatus>>
  >({});
  const [isSending, setIsSending] = useState(false);
  const [sendMessages, setSendMessages] = useState<readonly string[]>([]);
  const [sendHadProblem, setSendHadProblem] = useState(false);
  const companyInput = useRef<HTMLInputElement>(null);
  const isSendingRef = useRef(false);
  const runToken = useRef(0);
  // Whether the run on the page (finished or still running) used Drive files.
  const runUsedDrive = useRef(false);
  const timers = useRef<number[]>([]);

  const selectedCaseInfo =
    cases.find((item) => item.id === selectedCase) ?? cases[0];
  const isUploadSelected = selectedCase === "UPLOAD";
  const caseDescriptionTitle = isUploadSelected
    ? "Your uploaded documents"
    : selectedCaseInfo.name;
  const uploadedFileCountLabel = `${uploadedFiles.length} file${uploadedFiles.length === 1 ? "" : "s"} ready to check`;
  const caseDescriptionDetail = isUploadSelected
    ? uploadedFileCountLabel
    : selectedCaseInfo.detail;
  const [backendLoaded, setBackendLoaded] = useState(false);
  const [workpaper, setWorkpaper] = useState<Workpaper | null>(null);
  const [completedRun, setCompletedRun] = useState<CompletedRun | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const activeWorkpaper = useMemo<Workpaper>(() => {
    if (workpaper)
      return {
        ...workpaper,
        case_id:
          selectedCase === "UPLOAD" ? "UPLOADED_BUNDLE" : workpaper.case_id,
      };
    return {
      ...workpaperPayloadFallback,
      case_id:
        selectedCase === "UPLOAD"
          ? "UPLOADED_BUNDLE"
          : workpaperPayloadFallback.case_id,
    } as Workpaper;
  }, [workpaper, selectedCase]);
  const isComplete = runState === "complete";
  const hasResults = showsResults(runState);
  const ranOnUpload = (completedRun?.uploadedFileCount ?? 0) > 0;
  const resultsSourceLabel = ranOnUpload
    ? "Results from your documents"
    : "Results from a sample case";
  const failedRunNote = runMessage
    ? `${runMessage} Showing sample results, not your documents.`
    : "AuditFlow couldn't complete the check. Showing sample results, not your documents.";
  const humanQueue = useMemo(
    () => activeWorkpaper.rows.filter((row) => row.action === "human_review"),
    [activeWorkpaper],
  );

  useEffect(() => {
    setCompany(readStoredCompany());
  }, []);

  useEffect(
    () => () => timers.current.forEach((timer) => window.clearTimeout(timer)),
    [],
  );

  const beginReview = async () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    setSelectedRow(null);
    const run = startRun(runToken);
    runUsedDrive.current =
      selectedCase === "UPLOAD" && uploadedFiles.some((file) => driveIds.has(file));
    setSendStatuses({});
    setSendMessages([]);
    setSendHadProblem(false);
    setRunState("running");
    setActiveStage(0);

    const holdAtIndex = stages.length - 1;
    for (let index = 1; index <= holdAtIndex; index++) {
      timers.current.push(
        window.setTimeout(() => setActiveStage(index), index * 650),
      );
    }

    const outcome =
      selectedCase === "UPLOAD"
        ? await fetchWorkpaperFromUpload(uploadedFiles, useResolver)
        : await fetchWorkpaper(selectedCase);
    // A newer run, or a Drive disconnect, has replaced this one.
    if (!isCurrentRun(runToken, run)) return;
    const payload = outcome.workpaper;
    setRunMessage(outcome.message);
    // Copied at run time, so later UI changes (selectCase clears
    // uploadedFiles) cannot affect which files a ticket is built from.
    setUploadSnapshot(payload && outcome.uploadedFiles ? outcome.uploadedFiles : null);

    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];

    if (payload) {
      setWorkpaper(payload);
      setBackendLoaded(true);
    } else {
      setWorkpaper(workpaperPayloadFallback);
      setBackendLoaded(false);
    }

    setCompletedRun({
      completedAt: new Date(),
      uploadedFileCount: selectedCase === "UPLOAD" ? uploadedFiles.length : 0,
    });
    // Without a workpaper the steps didn't finish: sample results are shown
    // with a warning, but no step is marked done.
    setActiveStage(payload ? stages.length : -1);
    setRunState(finishedRunState(payload));
  };

  // Disconnecting Drive removes what came from it: its files, and the
  // results of a run that used them. Local files and results from runs
  // without Drive files stay. Tickets already in Zoho Desk are not touched.
  const dropDriveContent = () => {
    const cleanup = cleanUpAfterDisconnect(
      uploadedFiles,
      (file) => driveIds.has(file),
      runUsedDrive.current,
      runToken,
    );
    if (cleanup.removed > 0) {
      setUploadedFiles(cleanup.files);
      if (cleanup.files.length === 0 && selectedCase === "UPLOAD") {
        setSelectedCase(cases[0].id);
      }
    }
    if (cleanup.clearResults) {
      runUsedDrive.current = false;
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current = [];
      setRunState("ready");
      setActiveStage(-1);
      setSelectedRow(null);
      setWorkpaper(null);
      setBackendLoaded(false);
      setCompletedRun(null);
      setRunMessage(null);
      setUploadSnapshot(null);
      setSendStatuses({});
      setSendMessages([]);
      setSendHadProblem(false);
    }
    if (cleanup.removed > 0 || cleanup.clearResults) {
      setSelectionNotice({
        headline: cleanup.clearResults
          ? "Google Drive disconnected. Files from Drive and the results that used them were removed."
          : "Google Drive disconnected. Files from Drive were removed from this check.",
        details: [],
        problem: false,
      });
    }
  };

  // Resubscribed after every render, so the handler sees the latest state.
  useEffect(() => {
    if (!driveConfigured) return;
    return getDriveSession().onDisconnect(dropDriveContent);
  });

  // Builds the PDF from the result already on the page: the browser's print
  // window renders the print-only report. No backend call, nothing stored.
  const saveReport = () => {
    if (!workpaper || !completedRun) return;
    const previousTitle = document.title;
    // Local calendar date, so the file name matches the date in the report
    // (toISOString would give the UTC date).
    const { completedAt } = completedRun;
    const date = [
      completedAt.getFullYear(),
      String(completedAt.getMonth() + 1).padStart(2, "0"),
      String(completedAt.getDate()).padStart(2, "0"),
    ].join("-");
    // The page title becomes the browser's suggested PDF file name.
    const reportName =
      completedRun.uploadedFileCount > 0
        ? "uploaded documents"
        : workpaper.case_id;
    document.title = `AuditFlow report – ${reportName} – ${date}`;
    const restoreTitle = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };
    window.addEventListener("afterprint", restoreTitle);
    window.print();
  };

  // New local files replace earlier local files; files from Drive stay.
  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    const fromDrive = uploadedFiles.filter((file) => driveIds.has(file));
    const { accepted, skipped } = checkLocalFiles(chosen, fromDrive.length);
    const files = [...fromDrive, ...accepted];
    setUploadedFiles(files);
    setSelectionNotice(
      skipped.length > 0
        ? summarizeSelection("local", accepted.length, skipped, fromDrive.length)
        : null,
    );
    if (files.length > 0) setSelectedCase("UPLOAD");
  };

  const addDriveFiles = (
    imported: readonly ImportedFile[],
    summary: SelectionSummary | null,
  ) => {
    setSelectionNotice(summary);
    if (imported.length === 0) return;
    imported.forEach(({ file, driveId }) => driveIds.set(file, driveId));
    setUploadedFiles((current) => [
      ...current,
      ...imported.map(({ file }) => file),
    ]);
    setSelectedCase("UPLOAD");
  };

  const existingDriveIds = useMemo(
    () =>
      new Set(
        uploadedFiles.flatMap((file) => {
          const id = driveIds.get(file);
          return id ? [id] : [];
        }),
      ),
    [uploadedFiles, driveIds],
  );
  const driveHint = driveSelectHint(driveState);

  const selectCase = (caseId: CaseId) => {
    setSelectedCase(caseId);
    setUploadedFiles([]);
    setSelectionNotice(null);
  };

  const canSend = ranOnUpload && backendLoaded && uploadSnapshot !== null;
  // Save to Google Drive for the completed run; a new run starts afresh.
  const driveSave = useDriveSave(
    isComplete && backendLoaded && workpaper && completedRun
      ? {
          workpaper,
          completedAt: completedRun.completedAt,
          // The Company name field only exists for upload runs; a sample
          // case has no company.
          companyName: ranOnUpload ? company : null,
        }
      : null,
    completedRun?.completedAt.getTime() ?? "no-run",
  );
  const allFindings = useMemo(
    () => workpaper?.findings ?? [],
    [workpaper],
  );
  const pendingFindings = allFindings.filter(
    (finding) => !isTicketed(sendStatuses[finding.finding_id]),
  );

  const sendTooltip = canSend ? undefined : SAMPLE_SEND_TOOLTIP;

  // One request per finding, one after another. A run stops at the first
  // 401, 403, 429 or 503 because the next request would fail the same way.
  const sendFindings = async (list: readonly FindingDetail[]) => {
    if (isSendingRef.current || list.length === 0) return;
    if (!canSend || !workpaper || !uploadSnapshot) return;
    const companyName = company.trim();
    if (!companyName) {
      setCompanyMissing(true);
      companyInput.current?.focus();
      return;
    }
    const token = runToken.current;
    isSendingRef.current = true;
    setIsSending(true);
    setSendMessages([]);
    setSendHadProblem(false);
    const results: SendStatus[] = [];
    try {
      for (const finding of list) {
        setSendStatuses((current) => ({
          ...current,
          [finding.finding_id]: { state: "sending" },
        }));
        const outcome = await sendFinding({
          company: companyName,
          finding,
          workpaper,
          uploadedFiles: uploadSnapshot,
        });
        if (token !== runToken.current) return;
        results.push(outcome.status);
        setSendStatuses((current) => ({
          ...current,
          [finding.finding_id]: outcome.status,
        }));
        if (outcome.stop) break;
      }
      const notes = results.flatMap((status) =>
        status.state === "created" ? status.notes : [],
      );
      const clean =
        results.length === list.length &&
        results.every(
          (status) =>
            status.state === "created" || status.state === "duplicate",
        );
      setSendHadProblem(!clean);
      setSendMessages([
        summarizeRun(companyName, results, list.length),
        ...notes,
      ]);
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
    }
  };

  const changeCompany = (value: string) => {
    setCompany(value);
    storeCompany(value);
    if (value.trim()) setCompanyMissing(false);
  };

  const unmappedText = ranOnUpload && workpaper ? unmappedNotice(workpaper) : null;
  const ambiguousText =
    ranOnUpload && workpaper ? ambiguousNotice(workpaper) : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AuditFlow home">
          <span className="brand-mark">
            <Icon name="shield" size={21} />
          </span>
          <span>AuditFlow</span>
        </a>
        <div className="topbar-right">
          <div className="topbar-status">
            <span className="live-dot" /> Document checks · findings for review
          </div>
          <DriveConnectButton />
          <AccessCodeControl onChange={ignoreAccessCodeChange} />
        </div>
      </header>
      <DriveConnectMessages />

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">DOCUMENT REVIEW</p>
          <h1>
            Spot the mismatches.
            <br />
            <em>See the documents behind them.</em>
          </h1>
          <p className="hero-copy">
            Add invoices, purchase orders and receipts. AuditFlow compares
            them, lists any mismatches or missing documents, and flags each
            finding to a person to review.
          </p>
        </div>
        <div className="threshold-card">
          <span className="threshold-label">Review rule</span>
          <strong>Any finding needs review.</strong>
          <span>Items with no findings can be cleared.</span>
          <span>Confidence does not determine routing.</span>
        </div>
      </section>

      <section className="control-card" aria-labelledby="case-heading">
        <div className="control-heading">
          <div>
            <p className="eyebrow">01 · CHOOSE DOCUMENTS</p>
            <h2 id="case-heading">Check a set of documents</h2>
          </div>
        </div>
        <div className={`case-picker${driveConfigured ? " with-drive" : ""}`}>
          <label className="select-wrap">
            <span>Sample case</span>
            <select
              value={selectedCase}
              onChange={(event) => selectCase(event.target.value as CaseId)}
            >
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {caseDisplayName(item.id)} — {item.name}
                </option>
              ))}
              {uploadedFiles.length > 0 && (
                <option value="UPLOAD">Your uploaded documents</option>
              )}
            </select>
          </label>
          <div className="case-description">
            <strong>{caseDescriptionTitle}</strong>
            <span>{caseDescriptionDetail}</span>
          </div>
          <label className="upload-button">
            <Icon name="upload" size={17} />
            <span>Upload documents</span>
            <input
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              onChange={handleUpload}
              disabled={driveBusy !== null}
            />
          </label>
          <DriveFilePicker
            existingCount={uploadedFiles.length}
            existingIds={existingDriveIds}
            disabled={runState === "running"}
            onBusy={setDriveBusy}
            onDone={addDriveFiles}
          />
          <button
            className="primary-button"
            onClick={beginReview}
            disabled={runState === "running" || driveBusy !== null}
          >
            {runState === "running" ? (
              <>
                <span className="spinner" />
                <span>Checking documents…</span>
              </>
            ) : (
              <>
                <Icon name="play" size={15} />
                <span>Check documents</span>
              </>
            )}
          </button>
        </div>
        <p className="upload-limits">
          PDF, PNG, JPG or WEBP · up to 20 MB each · up to 10 files per check
        </p>
        {driveConfigured && (
          <div className="drive-select-status" role="status">
            {driveBusy ? (
              <p id="drive-select-progress" className="drive-select-progress">
                <span className="spinner dark" /> {driveBusy}
              </p>
            ) : (
              <p id="drive-select-hint" className="drive-select-hint">
                {driveHint ??
                  "Google Docs, Sheets and Slides files aren't supported yet. Save them as PDF first."}
              </p>
            )}
          </div>
        )}
        {selectionNotice && (
          <div
            className={`selection-summary${selectionNotice.problem ? " problem" : ""}`}
            role="status"
          >
            <p>{selectionNotice.headline}</p>
            {selectionNotice.details.length > 0 && (
              <ul>
                {selectionNotice.details.map((detail, index) => (
                  <li key={index}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {uploadedFiles.length > 0 && (
          <label className="resolver-toggle">
            <input
              type="checkbox"
              checked={useResolver}
              onChange={(e) => setUseResolver(e.target.checked)}
            />
            <span>
              Double-check missing-document findings (runs a second check)
            </span>
          </label>
        )}
        {uploadedFiles.length > 0 && (
          <p className="upload-note">
            <Icon name="check" size={15} />{" "}
            {uploadedFiles.map((file) => file.name).join(", ")} ready to check.
            Select &ldquo;Check documents&rdquo; to start.
          </p>
        )}
      </section>

      <section className="pipeline" aria-label="Check progress">
        <div className="pipeline-heading">
          <p className="eyebrow">02 · PROGRESS</p>
          <span>Read → Match → Check → Route → Report</span>
        </div>
        {runState === "failed" && (
          <p className="pipeline-failed" role="status">
            The check didn&apos;t finish, so these steps weren&apos;t
            completed.
          </p>
        )}
        <div className="stage-grid">
          {stages.map((stage, index) => {
            const stageState = resolveStageState(index, activeStage, runState);
            return (
              <div
                className={`stage ${stageState}`}
                key={stage.name}
                aria-label={`${stage.name}: ${stageStateLabel[stageState]}`}
              >
                <span className="stage-icon">
                  {stageState === "complete" ? (
                    <Icon name="check" size={17} />
                  ) : stageState === "failed" ? (
                    <Icon name="close" size={15} />
                  ) : (
                    stage.icon
                  )}
                </span>
                <div>
                  <strong>{stage.name}</strong>
                  <small>{stage.description}</small>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {hasResults && (
        <section className="results" aria-labelledby="workpaper-heading">
          <div className="workpaper-header">
            <div>
              <p className="eyebrow">03 · RESULTS</p>
              <h2 id="workpaper-heading">
                {caseDisplayName(activeWorkpaper.case_id)}{" "}
                <span>· findings</span>
              </h2>
            </div>
            <div className="workpaper-meta">
              <ResolverBadge resolution={activeWorkpaper.evidence_resolution} />
              <p className="contract-note">
                {backendLoaded
                  ? resultsSourceLabel
                  : failedRunNote}
              </p>
            </div>
          </div>
          <ResultsActions
            savePdf={
              backendLoaded ? (
                <button
                  className="secondary-button"
                  onClick={saveReport}
                  aria-describedby={SAVE_PDF_HINT_ID}
                >
                  <Icon name="note" size={15} />
                  <span>Save PDF report</span>
                </button>
              ) : null
            }
            driveSave={
              showsDriveSaveAction(driveSave) ? (
                <DriveSaveAction control={driveSave} />
              ) : null
            }
            sendAll={
              backendLoaded ? (
                <SendAllButton
                  count={pendingFindings.length}
                  canSend={canSend}
                  isSending={isSending}
                  tooltip={sendTooltip}
                  onSend={() => void sendFindings(pendingFindings)}
                />
              ) : null
            }
            caption={
              backendLoaded || showsDriveSaveAction(driveSave) ? (
                <>
                  {backendLoaded && (
                    <span id={SAVE_PDF_HINT_ID}>
                      {"Save PDF report opens your browser's print window. Choose Save as PDF."}
                    </span>
                  )}
                  {backendLoaded && showsDriveSaveAction(driveSave) && " "}
                  {/* Only while the Drive button shows. */}
                  {showsDriveSaveAction(driveSave) && (
                    <span id={DRIVE_SAVE_HINT_ID}>{DRIVE_SAVE_HINT}</span>
                  )}
                </>
              ) : null
            }
            status={
              showsDriveSaveStatus(driveSave) ? (
                <DriveSaveStatus control={driveSave} />
              ) : null
            }
          />
          {ranOnUpload && (
            <div className="send-panel">
              <label className="company-field">
                <span>
                  Company name <em>required</em>
                </span>
                <input
                  ref={companyInput}
                  type="text"
                  required
                  maxLength={COMPANY_MAX_LENGTH}
                  value={company}
                  onChange={(event) => changeCompany(event.target.value)}
                  aria-invalid={companyMissing}
                  aria-describedby="company-hint"
                  autoComplete="organization"
                />
              </label>
              <p id="company-hint" className="send-hint">
                Tickets are grouped under this company in Zoho Desk.
              </p>
              {companyMissing && (
                <p className="send-message problem" role="alert">
                  Enter the company name before sending.
                </p>
              )}
              {sendMessages.map((message) => (
                <p
                  key={message}
                  className={`send-message ${sendHadProblem ? "problem" : "ok"}`}
                >
                  {message}
                </p>
              ))}
              {unmappedText && <p className="send-notice">{unmappedText}</p>}
              {ambiguousText && <p className="send-notice">{ambiguousText}</p>}
            </div>
          )}
          <div className="sr-only" aria-live="polite" role="status">
            {sendMessages.join(" ")}
          </div>
          {/* Severity is hidden from clients because it varies between runs; the data stays in the types and response. */}
          <div className="metrics" aria-label="Results summary">
            <Metric
              value={activeWorkpaper.summary.items_reviewed}
              label="Transactions checked"
              tone="dark"
            />
            <Metric
              value={activeWorkpaper.summary.auto_cleared}
              label="No findings"
              tone="mint"
            />
            <Metric
              value={activeWorkpaper.summary.human_review}
              label="Needs review"
              tone="amber"
            />
          </div>
          <div className="workpaper-layout">
            <div className="table-card">
              <div className="table-intro">
                <div>
                  <h3>Findings by document</h3>
                  <p>
                    Select a row to see what was found and which documents
                    were used.
                  </p>
                </div>
                <span>
                  {humanQueue.length}{" "}
                  {humanQueue.length === 1 ? "needs" : "need"} review
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Finding</th>
                      <th>Related documents</th>
                      <th>Confidence (reference only)</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeWorkpaper.rows.map((row) => (
                      <WorkpaperTableRow
                        key={row.document}
                        row={row}
                        isSelected={selectedRow?.document === row.document}
                        selectedCase={selectedCase}
                        onSelect={setSelectedRow}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <ExceptionPanel
              key={selectedRow ? selectedRow.document : "none"}
              row={selectedRow}
              resolution={activeWorkpaper.evidence_resolution}
              findings={activeWorkpaper.findings}
              isSampleData={!backendLoaded}
              onClose={() => setSelectedRow(null)}
              sendStatuses={sendStatuses}
              canSend={canSend}
              isSending={isSending}
              tooltip={sendTooltip}
              onSend={(finding) => void sendFindings([finding])}
            />
          </div>
        </section>
      )}

      {isComplete && backendLoaded && workpaper && completedRun && (
        <PrintReport
          workpaper={workpaper}
          completedAt={completedRun.completedAt}
          uploadedFileCount={completedRun.uploadedFileCount}
        />
      )}
    </main>
  );
}

interface WorkpaperTableRowProps {
  readonly row: WorkpaperRow;
  readonly isSelected: boolean;
  readonly selectedCase: CaseId;
  readonly onSelect: (row: WorkpaperRow) => void;
}

function WorkpaperTableRow({
  row,
  isSelected,
  selectedCase,
  onSelect,
}: WorkpaperTableRowProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter") onSelect(row);
  };
  return (
    <tr
      className={isSelected ? "selected" : ""}
      onClick={() => onSelect(row)}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <td>
        <strong>{row.document}</strong>
        <small>
          {selectedCase === "UPLOAD" ? "Uploaded document" : "Sample document"}
        </small>
      </td>
      <td>
        <span
          className={`finding ${row.finding === "Clean" ? "clean" : "exception"}`}
        >
          {findingLabel(row.finding)}
        </span>
      </td>
      <td>
        <div className="evidence-list">
          {row.evidence.slice(0, 3).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {row.evidence.length > 3 && <span>+{row.evidence.length - 3}</span>}
        </div>
      </td>
      <td>
        <div className="confidence">
          <b>{formatConfidence(row.confidence)}</b>
          <span>
            <i style={{ width: `${row.confidence * 100}%` }} />
          </span>
        </div>
      </td>
      <td>
        <span className={`action ${row.action}`}>
          {actionLabel(row.action)}
        </span>
      </td>
    </tr>
  );
}

interface ExceptionPanelProps {
  readonly row: WorkpaperRow | null;
  readonly resolution?: EvidenceResolution | null;
  readonly findings?: readonly FindingDetail[];
  readonly isSampleData: boolean;
  readonly onClose: () => void;
  readonly sendStatuses: Partial<Record<string, SendStatus>>;
  readonly canSend: boolean;
  readonly isSending: boolean;
  readonly tooltip?: string;
  readonly onSend: (finding: FindingDetail) => void;
}

function ExceptionPanel({
  row,
  resolution,
  findings,
  isSampleData,
  onClose,
  sendStatuses,
  canSend,
  isSending,
  tooltip,
  onSend,
}: ExceptionPanelProps) {
  if (!row)
    return (
      <aside className="decision-panel" aria-live="polite">
        <div className="empty-detail">
          <span className="empty-icon">
            <Icon name="note" size={23} />
          </span>
          <h3>Select a finding</h3>
          <p>
            Select a row to see what was found, the documents involved, and
            why it needs review or can be cleared.
          </p>
        </div>
      </aside>
    );
  const isClear = row.action === "auto_clear";
  // The hand-written narrative and severity describe the sample documents
  // only; live results don't carry them, so they are never shown there.
  const sampleDetail = isSampleData ? detailByDocument[row.document] : undefined;
  const fallbackReason = isClear
    ? "No mismatches or missing documents were found for this item."
    : "No further detail is available for this item. Check the listed documents.";
  const rowFindings = (findings ?? []).filter(
    (finding) => finding.row_document === row.document,
  );
  return (
    <aside className="decision-panel" aria-live="polite">
      <button
        className="panel-close"
        onClick={onClose}
        aria-label="Close detail"
      >
        <Icon name="close" size={18} />
      </button>
      <p className="eyebrow">FINDING DETAIL</p>
      <h3>{findingLabel(row.finding)}</h3>
      <p className="detail-doc">
        {row.document}
      </p>
      <Detail label="Finding" value={findingLabel(row.finding)} />
      <Detail
        label="Related documents"
        value={
          <div className="detail-evidence">
            {row.evidence.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        }
      />
      <Detail
        label="Confidence"
        value={`${formatConfidence(row.confidence)} — for reference; does not affect whether an item needs review`}
      />
      <Detail label="AuditFlow result" value={actionLabel(row.action)} />
      <Detail
        label={isClear ? "Why it can be cleared" : "Why it was flagged"}
        value={
          rowFindings.length > 0 ? (
            <>
              {rowFindings.length >= 2 && (
                <p className="finding-count">{rowFindings.length} findings</p>
              )}
              <div className="finding-blocks">
                {rowFindings.map((finding) => (
                  <FindingBlock
                    key={finding.finding_id}
                    finding={finding}
                    status={sendStatuses[finding.finding_id]}
                    canSend={canSend}
                    isSending={isSending}
                    tooltip={tooltip}
                    onSend={onSend}
                  />
                ))}
              </div>
            </>
          ) : (
            (sampleDetail?.reason ?? fallbackReason)
          )
        }
      />
      {resolution && (
        <Detail label="Double-check" value={resolverSummary(resolution)} />
      )}
    </aside>
  );
}

interface FindingBlockProps {
  readonly finding: FindingDetail;
  readonly status?: SendStatus;
  readonly canSend: boolean;
  readonly isSending: boolean;
  readonly tooltip?: string;
  readonly onSend: (finding: FindingDetail) => void;
}

function FindingBlock({
  finding,
  status,
  canSend,
  isSending,
  tooltip,
  onSend,
}: FindingBlockProps) {
  const matches = matchedDocuments(finding);
  return (
    <div className="finding-block">
      <div className="finding-block-head">
        <strong>{finding.label}</strong>
      </div>
      <p>{finding.explanation}</p>
      {finding.documents.length > 0 && (
        <div className="detail-evidence">
          {finding.documents.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}
      {finding.type === "duplicate_invoice" && matches.length > 0 && (
        <p className="finding-matches">
          Possible duplicate of:{" "}
          {matches.join(", ")}
        </p>
      )}
      <FindingSend
        finding={finding}
        status={status}
        canSend={canSend}
        isSending={isSending}
        tooltip={tooltip}
        onSend={onSend}
      />
    </div>
  );
}

function sendButtonLabel(status: SendStatus | undefined): string {
  if (status?.state === "sending") return "Sending…";
  if (status?.state === "unconfirmed" || status?.state === "failed") {
    return "Retry";
  }
  return "Send to Zoho Desk";
}

function FindingSend({
  finding,
  status,
  canSend,
  isSending,
  tooltip,
  onSend,
}: FindingBlockProps) {
  const blocked = !canSend || isSending;
  const ticketed = isTicketed(status);
  const handleClick = () => {
    if (!blocked) onSend(finding);
  };
  return (
    <div className="finding-send">
      <SendChip status={status} />
      {!ticketed && (
        <button
          type="button"
          className="send-button"
          aria-disabled={blocked}
          title={tooltip}
          onClick={handleClick}
        >
          {sendButtonLabel(status)}
        </button>
      )}
      {status?.state === "created" &&
        status.notes.map((note) => (
          <p key={note} className="send-message problem">
            {note}
          </p>
        ))}
      {status?.state === "failed" && (
        <p className="send-message problem">{status.message}</p>
      )}
      {status?.state === "unconfirmed" && (
        <p className="send-message problem">{status.message}</p>
      )}
    </div>
  );
}

interface SendChipProps {
  readonly status?: SendStatus;
}

function SendChip({ status }: SendChipProps) {
  if (!status) return <span className="send-chip idle">Not sent</span>;
  if (status.state === "sending") {
    return <span className="send-chip busy">Sending</span>;
  }
  if (status.state === "unconfirmed") {
    return <span className="send-chip warn">Couldn&apos;t confirm (not sent)</span>;
  }
  if (status.state === "failed") {
    return <span className="send-chip bad">Failed</span>;
  }
  const url = safeTicketUrl(status.webUrl);
  const number = ticketLabel(status);
  const text =
    status.state === "created"
      ? `Ticket ${number}`.trim()
      : `Already in Zoho Desk ${number}`.trim();
  if (!url) return <span className="send-chip done">{text}</span>;
  return (
    <a
      className="send-chip done"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {text}
    </a>
  );
}

interface SendAllButtonProps {
  readonly count: number;
  readonly canSend: boolean;
  readonly isSending: boolean;
  readonly tooltip?: string;
  readonly onSend: () => void;
}

function SendAllButton({
  count,
  canSend,
  isSending,
  tooltip,
  onSend,
}: SendAllButtonProps) {
  const blocked = !canSend || isSending || count === 0;
  const handleClick = () => {
    if (!blocked) onSend();
  };
  return (
    <button
      type="button"
      className="secondary-button"
      aria-disabled={blocked}
      title={tooltip}
      onClick={handleClick}
    >
      <span>
        {isSending
          ? "Sending to Zoho Desk…"
          : `Send all findings to Zoho Desk (${count})`}
      </span>
    </button>
  );
}

interface MetricProps {
  readonly value: string | number;
  readonly label: string;
  readonly tone: "dark" | "mint" | "amber" | "coral" | "plain";
}

function Metric({ value, label, tone }: MetricProps) {
  return (
    <div className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

interface ResolverBadgeProps {
  readonly resolution?: EvidenceResolution | null;
}

function ResolverBadge({ resolution }: ResolverBadgeProps) {
  if (!resolution) return null; // resolver wasn't used for this run
  if (!resolution.second_pass_run)
    return (
      <span className="resolver-badge none">
        Double-check: not needed
      </span>
    );
  return resolution.agreement ? (
    <span className="resolver-badge confirmed">
      Double-check: results agreed
    </span>
  ) : (
    <span className="resolver-badge disagreement">
      Double-check: results differed, review both
    </span>
  );
}

interface DetailProps {
  readonly label: string;
  readonly value: ReactNode;
}

function Detail({ label, value }: DetailProps) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <div>{value}</div>
    </div>
  );
}
