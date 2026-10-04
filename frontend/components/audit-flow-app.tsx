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
import { persistFeedback } from "../lib/feedback";
import {
  actionLabel,
  caseDisplayName,
  findingLabel,
  resolverSummary,
} from "../lib/display-labels";
import type {
  Confidence,
  EvidenceResolution,
  Workpaper,
  WorkpaperRow,
} from "../types/workpaper";
import type { FeedbackDecision, FeedbackRecord } from "../types/feedback";
import { Icon } from "./icons";
import { FeedbackHistoryPanel } from "./feedback-history";
import { PrintReport } from "./print-report";

type RunState = "ready" | "running" | "complete";
type StageState = "idle" | "active" | "complete";

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

const stageStateLabel: Record<StageState, string> = {
  idle: "not started",
  active: "in progress",
  complete: "done",
};

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
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_04",
    name: "Transaction 04 · Amount mismatch",
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_05",
    name: "Transaction 05 · Missing PO",
    detail: "Expected result: sent for review · medium severity",
  },
  {
    id: "CASE_06",
    name: "Transaction 06 · Missing receipt",
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_07",
    name: "Transaction 07 · Vendor mismatch",
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_08",
    name: "Transaction 08 · Date inconsistency",
    detail: "Expected result: sent for review · medium severity",
  },
  {
    id: "CASE_09",
    name: "Transaction 09 · Duplicate invoice, amount mismatch, missing receipt",
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_10",
    name: "Transaction 10 · Vendor mismatch, date inconsistency",
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_11",
    name: "Transaction 11 · Missing PO, amount mismatch",
    detail: "Expected result: sent for review · medium to high severity",
  },
  {
    id: "CASE_12",
    name: "Transaction 12 · Missing receipt",
    detail: "Expected result: sent for review · medium severity",
  },
  {
    id: "CASE_13",
    name: "Transaction 13 · Currency mismatch",
    detail: "Expected result: sent for review · high severity",
  },
  {
    id: "CASE_14",
    name: "Transaction 14 · Tax mismatch",
    detail: "Expected result: sent for review · medium severity",
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

const reviewerDecisionCopy: Record<FeedbackDecision, string> = {
  confirmed: "Confirmed",
  overturned: "Overturned",
  evidence_requested: "Evidence requested",
};

const formatConfidence = (value: Confidence) => `${Math.round(value * 100)}%`;

function resolveStageState(
  index: number,
  activeStage: number,
  runState: RunState,
): StageState {
  if (runState === "ready") return "idle";
  if (index < activeStage) return "complete";
  if (index === activeStage && runState === "running") return "active";
  if (runState === "complete") return "complete";
  return "idle";
}

export function AuditFlowApp() {
  const [selectedCase, setSelectedCase] = useState<CaseId>(cases[0].id);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [useResolver, setUseResolver] = useState(false);
  const [runState, setRunState] = useState<RunState>("ready");
  const [activeStage, setActiveStage] = useState(-1);
  const [selectedRow, setSelectedRow] = useState<WorkpaperRow | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<
    Partial<Record<string, FeedbackDecision>>
  >({});
  const [reviewNote, setReviewNote] = useState("");
  const [feedbackLog, setFeedbackLog] = useState<FeedbackRecord[]>([]);
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
  const humanQueue = useMemo(
    () => activeWorkpaper.rows.filter((row) => row.action === "human_review"),
    [activeWorkpaper],
  );

  useEffect(
    () => () => timers.current.forEach((timer) => window.clearTimeout(timer)),
    [],
  );

  const beginReview = async () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    setSelectedRow(null);
    setReviewDecisions({});
    setReviewNote("");
    setRunState("running");
    setActiveStage(0);

    const holdAtIndex = stages.length - 1;
    for (let index = 1; index <= holdAtIndex; index++) {
      timers.current.push(
        window.setTimeout(() => setActiveStage(index), index * 650),
      );
    }

    const payload =
      selectedCase === "UPLOAD"
        ? await fetchWorkpaperFromUpload(uploadedFiles, useResolver)
        : await fetchWorkpaper(selectedCase);

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
    setActiveStage(stages.length);
    setRunState("complete");
  };

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
    document.title = `AuditFlow report – ${workpaper.case_id} – ${date}`;
    const restoreTitle = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };
    window.addEventListener("afterprint", restoreTitle);
    window.print();
  };

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    setUploadedFiles(files);
    if (files.length > 0) setSelectedCase("UPLOAD");
  };

  const selectCase = (caseId: CaseId) => {
    setSelectedCase(caseId);
    setUploadedFiles([]);
  };

  const chooseDecision = (decision: FeedbackDecision) => {
    if (!selectedRow) return;
    const record: FeedbackRecord = {
      case_id: activeWorkpaper.case_id,
      document: selectedRow.document,
      finding: selectedRow.finding,
      agent_action: selectedRow.action,
      decision,
      note: reviewNote.trim() || undefined,
      timestamp: new Date().toISOString(),
    };
    setReviewDecisions((current) => ({
      ...current,
      [selectedRow.document]: decision,
    }));
    setFeedbackLog((current) => [...current, record]);
    void persistFeedback(record);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AuditFlow home">
          <span className="brand-mark">
            <Icon name="shield" size={21} />
          </span>
          <span>AuditFlow</span>
        </a>
        <div className="topbar-status">
          <span className="live-dot" /> Document checks · findings for review
        </div>
      </header>

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
            them, lists any mismatches or missing documents, and sends each
            finding to a person to review.
          </p>
        </div>
        <div className="threshold-card">
          <span className="threshold-label">Review rule</span>
          <strong>Any finding is sent for review.</strong>
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
        <div className="case-picker">
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
            />
          </label>
          <button
            className="primary-button"
            onClick={beginReview}
            disabled={runState === "running"}
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

      {isComplete && (
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
                  ? "Results from your documents"
                  : "AuditFlow couldn't complete the check. Showing sample results, not your documents."}
              </p>
              {backendLoaded && (
                <div className="report-action">
                  <button className="secondary-button" onClick={saveReport}>
                    <Icon name="note" size={15} />
                    <span>Save PDF report</span>
                  </button>
                  <small>
                    {"Opens your browser's print window. Choose Save as PDF."}
                  </small>
                </div>
              )}
            </div>
          </div>
          <div className="metrics" aria-label="Results summary">
            <Metric
              value={activeWorkpaper.summary.items_reviewed}
              label="Items checked"
              tone="dark"
            />
            <Metric
              value={activeWorkpaper.summary.auto_cleared}
              label="No findings"
              tone="mint"
            />
            <Metric
              value={activeWorkpaper.summary.human_review}
              label="Sent for review"
              tone="amber"
            />
            <Metric
              value={activeWorkpaper.summary.critical}
              label="High severity"
              tone="coral"
            />
            <Metric
              value={`${activeWorkpaper.summary.assumed_minutes_per_item} min`}
              label="Assumed minutes per cleared item"
              tone="plain"
            />
            <Metric
              value={`${activeWorkpaper.summary.estimated_minutes_saved} min`}
              label="Estimated minutes saved"
              tone="dark"
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
                <span>{humanQueue.length} awaiting review</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Finding</th>
                      <th>Documents used</th>
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
                        reviewerDecision={reviewDecisions[row.document]}
                        selectedCase={selectedCase}
                        onSelect={setSelectedRow}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <ExceptionPanel
              row={selectedRow}
              decision={
                selectedRow ? reviewDecisions[selectedRow.document] : undefined
              }
              reviewNote={reviewNote}
              resolution={activeWorkpaper.evidence_resolution}
              isSampleData={!backendLoaded}
              onClose={() => setSelectedRow(null)}
              onDecision={chooseDecision}
              onNoteChange={setReviewNote}
            />
          </div>
          <p className="assumption">
            <Icon name="clock" size={16} /> Estimated time saved assumes{" "}
            <strong>
              {activeWorkpaper.summary.assumed_minutes_per_item} minutes per
              item with no findings
            </strong>
            : {activeWorkpaper.summary.auto_cleared} ×{" "}
            {activeWorkpaper.summary.assumed_minutes_per_item} ={" "}
            {activeWorkpaper.summary.estimated_minutes_saved} minutes. This is
            an estimate, not a measured figure.
          </p>
        </section>
      )}

      <FeedbackHistoryPanel sessionLog={feedbackLog} />

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
  readonly reviewerDecision?: FeedbackDecision;
  readonly selectedCase: CaseId;
  readonly onSelect: (row: WorkpaperRow) => void;
}

function WorkpaperTableRow({
  row,
  isSelected,
  reviewerDecision,
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
          {reviewerDecision
            ? reviewerDecisionCopy[reviewerDecision]
            : actionLabel(row.action)}
        </span>
      </td>
    </tr>
  );
}

interface ExceptionPanelProps {
  readonly row: WorkpaperRow | null;
  readonly decision?: FeedbackDecision;
  readonly reviewNote: string;
  readonly resolution?: EvidenceResolution | null;
  readonly isSampleData: boolean;
  readonly onClose: () => void;
  readonly onDecision: (decision: FeedbackDecision) => void;
  readonly onNoteChange: (value: string) => void;
}

function ExceptionPanel({
  row,
  decision,
  reviewNote,
  resolution,
  isSampleData,
  onClose,
  onDecision,
  onNoteChange,
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
    : "No further detail is available for this item. Check the listed documents before recording your decision.";
  const severity =
    sampleDetail && sampleDetail.severity !== "None"
      ? sampleDetail.severity
      : null;
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
        {severity && <span> · {severity} severity</span>}
      </p>
      <Detail label="Finding" value={findingLabel(row.finding)} />
      <Detail
        label="Documents used"
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
        value={`${formatConfidence(row.confidence)} — for reference; does not affect whether an item is sent for review`}
      />
      <Detail label="AuditFlow result" value={actionLabel(row.action)} />
      <Detail
        label={isClear ? "Why it can be cleared" : "Why it was flagged"}
        value={sampleDetail?.reason ?? fallbackReason}
      />
      <Detail label="Documents involved" value={row.evidence.join(" · ")} />
      {resolution && (
        <Detail label="Double-check" value={resolverSummary(resolution)} />
      )}
      <div className="review-actions">
        <p>Your decision</p>
        <div>
          <button
            className={decision === "confirmed" ? "active-decision" : ""}
            onClick={() => onDecision("confirmed")}
          >
            Confirm finding
          </button>
          <button
            className={
              decision === "evidence_requested" ? "active-decision" : ""
            }
            onClick={() => onDecision("evidence_requested")}
          >
            Request evidence
          </button>
          <button
            className={
              decision === "overturned" ? "active-decision danger" : "danger"
            }
            onClick={() => onDecision("overturned")}
          >
            Overturn decision
          </button>
        </div>
        <label className="note-field">
          <span>
            Reviewer note <em>optional</em>
          </span>
          <textarea
            value={reviewNote}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="Add a note explaining your decision…"
            rows={2}
          />
        </label>
      </div>
    </aside>
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
