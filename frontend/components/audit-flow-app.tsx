"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { fetchWorkpaper, workpaperPayloadFallback } from "../lib/mock-workpaper";
import type { Action, Confidence, Workpaper, WorkpaperRow } from "../types/workpaper";
import { Icon } from "./icons";

type RunState = "ready" | "running" | "complete";
type StageState = "idle" | "active" | "complete";
type ReviewerDecision = "cleared" | "escalated" | "evidence_requested";

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

interface ExceptionDetail {
  reason: string;
  severity: "None" | "High";
}

const stages: Stage[] = [
  { name: "Intake", description: "Classify source documents", icon: "↓" },
  { name: "Evidence", description: "Link supporting records", icon: "⌘" },
  { name: "Anomaly", description: "Check bounded exceptions", icon: "⌁" },
  { name: "Decision", description: "Apply review thresholds", icon: "✓" },
  { name: "Workpaper", description: "Compile review-ready output", icon: "▤" },
];

const cases = [
  { id: "CASE_01", name: "TXN_01 · no expected findings", detail: "Expected action: auto_clear" },
  { id: "CASE_02", name: "TXN_02 · no expected findings", detail: "Expected action: auto_clear" },
  { id: "CASE_03", name: "TXN_03 · duplicate_invoice", detail: "Expected action: human_review · high severity" },
  { id: "CASE_04", name: "TXN_04 · amount_mismatch", detail: "Expected action: human_review · high severity" },
  { id: "CASE_05", name: "TXN_05 · missing_po", detail: "Expected action: human_review · medium severity" },
  { id: "CASE_06", name: "TXN_06 · missing_receipt", detail: "Expected action: human_review · high severity" },
  { id: "CASE_07", name: "TXN_07 · vendor_mismatch", detail: "Expected action: human_review · high severity" },
  { id: "CASE_08", name: "TXN_08 · date_inconsistency", detail: "Expected action: human_review · medium severity" },
  { id: "CASE_09", name: "TXN_09 · duplicate_invoice, amount_mismatch, missing_receipt", detail: "Expected action: human_review · high severity" },
  { id: "CASE_10", name: "TXN_10 · vendor_mismatch, date_inconsistency", detail: "Expected action: human_review · high severity" },
  { id: "CASE_11", name: "TXN_11 · missing_po, amount_mismatch", detail: "Expected action: human_review · medium/high severity" },
  { id: "CASE_12", name: "TXN_12 · missing_receipt", detail: "Expected action: human_review · medium severity" },
] as const satisfies readonly AuditCase[];

type BenchmarkCaseId = (typeof cases)[number]["id"];
type CaseId = BenchmarkCaseId | "UPLOAD";

const detailByDocument: Record<string, ExceptionDetail> = {
  "INV-1001": { reason: "All expected supporting records agree on vendor, date, and amount.", severity: "None" },
  "INV-1004": { reason: "Invoice total is INR 82,500.00; the approved PO is INR 75,000.00. The receipt, bank record, and ledger align with the invoice.", severity: "High" },
  "INV-1006": { reason: "No signed goods or service receipt is present for this payment, which requires receipt evidence under the purchase order terms.", severity: "High" },
  "INV-1007": { reason: "Supplier naming differs between the purchase order and invoice; supporting records do not resolve the entity mismatch.", severity: "High" },
};

const reviewerDecisionCopy: Record<ReviewerDecision, string> = {
  cleared: "Cleared by reviewer",
  escalated: "Escalated",
  evidence_requested: "Evidence requested",
};

const formatConfidence = (value: Confidence) => `${Math.round(value * 100)}%`;
const actionLabel = (action: Action) => action === "auto_clear" ? "Auto-cleared" : "Human review";

export function AuditFlowApp() {
  const [selectedCase, setSelectedCase] = useState<CaseId>(cases[0].id);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [runState, setRunState] = useState<RunState>("ready");
  const [activeStage, setActiveStage] = useState(-1);
  const [selectedRow, setSelectedRow] = useState<WorkpaperRow | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Partial<Record<string, ReviewerDecision>>>({});
  const [reviewNote, setReviewNote] = useState("");
  const timers = useRef<number[]>([]);

  const selectedCaseInfo = cases.find((item) => item.id === selectedCase) ?? cases[0];
  const [backendLoaded, setBackendLoaded] = useState(false);
  const [workpaper, setWorkpaper] = useState<Workpaper | null>(null);

  const activeWorkpaper = useMemo<Workpaper>(() => {
    if (workpaper) return { ...workpaper, case_id: selectedCase === "UPLOAD" ? "UPLOADED_BUNDLE" : workpaper.case_id };
    return { ...workpaperPayloadFallback, case_id: selectedCase === "UPLOAD" ? "UPLOADED_BUNDLE" : workpaperPayloadFallback.case_id } as Workpaper;
  }, [workpaper, selectedCase]);
  const isComplete = runState === "complete";
  const humanQueue = useMemo(() => activeWorkpaper.rows.filter((row) => row.action === "human_review"), [activeWorkpaper]);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const beginReview = async () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    setSelectedRow(null);
    setReviewDecisions({});
    setReviewNote("");
    setRunState("running");
    setActiveStage(0);

    const payload = await fetchWorkpaper(selectedCase);
    if (payload) {
      setWorkpaper(payload);
      setBackendLoaded(true);
    } else {
      setWorkpaper(workpaperPayloadFallback);
      setBackendLoaded(false);
    }

    stages.forEach((_, index) => {
      timers.current.push(window.setTimeout(() => setActiveStage(index), index * 650));
    });
    timers.current.push(window.setTimeout(() => {
      setActiveStage(stages.length);
      setRunState("complete");
    }, stages.length * 650));
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

  const chooseDecision = (decision: ReviewerDecision) => {
    if (!selectedRow) return;
    setReviewDecisions((current) => ({ ...current, [selectedRow.document]: decision }));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AuditFlow home"><span className="brand-mark"><Icon name="shield" size={21} /></span><span>AuditFlow</span></a>
        <div className="topbar-status"><span className="live-dot" /> Local demo · reviewer workspace</div>
      </header>

      <section className="hero" id="top">
        <div><p className="eyebrow">WORKPAPER REVIEW</p><h1>Give every exception<br /><em>its evidence.</em></h1><p className="hero-copy">Turn document bundles into a review-ready workpaper, with the rationale to decide what happens next.</p></div>
        <div className="threshold-card"><span className="threshold-label">Decision policy</span><strong>≥ 95% <span>auto-clear</span></strong><span>Below 95% routes to review</span></div>
      </section>

      <section className="control-card" aria-labelledby="case-heading">
        <div className="control-heading"><div><p className="eyebrow">01 · SELECT A BUNDLE</p><h2 id="case-heading">Start an audit run</h2></div><span className="simulated-badge">SIMULATED LOCAL FLOW</span></div>
        <div className="case-picker">
          <label className="select-wrap"><span>Audit case</span><select value={selectedCase} onChange={(event) => selectCase(event.target.value as CaseId)}>{cases.map((item) => <option key={item.id} value={item.id}>{item.id} — {item.name}</option>)}{uploadedFiles.length > 0 && <option value="UPLOAD">Uploaded document bundle</option>}</select></label>
          <div className="case-description"><strong>{selectedCase === "UPLOAD" ? "Uploaded document bundle" : selectedCaseInfo.name}</strong><span>{selectedCase === "UPLOAD" ? `${uploadedFiles.length} file${uploadedFiles.length === 1 ? "" : "s"} staged for a simulated run` : selectedCaseInfo.detail}</span></div>
          <label className="upload-button"><Icon name="upload" size={17} /><span>Upload documents</span><input type="file" multiple accept=".pdf,.txt,.csv,.xlsx,.png,.jpg,.jpeg" onChange={handleUpload} /></label>
          <button className="primary-button" onClick={beginReview} disabled={runState === "running"}>{runState === "running" ? <><span className="spinner" />Processing</> : <><Icon name="play" size={15} /> Run AuditFlow</>}</button>
        </div>
        {uploadedFiles.length > 0 && <p className="upload-note"><Icon name="check" size={15} /> {uploadedFiles.map((file) => file.name).join(", ")} ready. This demo does not upload data to a server.</p>}
      </section>

      <section className="pipeline" aria-label="Simulated AuditFlow agent pipeline">
        <div className="pipeline-heading"><p className="eyebrow">02 · AGENT PIPELINE</p><span>Clearly marked simulation</span></div>
        <div className="stage-grid">
          {stages.map((stage, index) => {
            const stageState: StageState = runState === "ready" ? "idle" : index < activeStage ? "complete" : index === activeStage && runState === "running" ? "active" : isComplete ? "complete" : "idle";
            return <div className={`stage ${stageState}`} key={stage.name} aria-label={`${stage.name}: ${stageState}`}><span className="stage-icon">{stageState === "complete" ? <Icon name="check" size={17} /> : stage.icon}</span><div><strong>{stage.name}</strong><small>{stage.description}</small></div></div>;
          })}
        </div>
      </section>

      {isComplete && <section className="results" aria-labelledby="workpaper-heading">
        <div className="workpaper-header"><div><p className="eyebrow">03 · WORKPAPER OUTPUT</p><h2 id="workpaper-heading">{activeWorkpaper.case_id} <span>· review register</span></h2></div><p className="contract-note">{backendLoaded ? "Live Backend Data" : "Fallback Demo Data"}</p></div>
        <div className="metrics" aria-label="Workpaper summary"><Metric value={activeWorkpaper.summary.items_reviewed} label="Reviewed" tone="dark" /><Metric value={activeWorkpaper.summary.auto_cleared} label="Auto-cleared" tone="mint" /><Metric value={activeWorkpaper.summary.human_review} label="Human review" tone="amber" /><Metric value={activeWorkpaper.summary.critical} label="Critical" tone="coral" /><Metric value={`${activeWorkpaper.summary.assumed_minutes_per_item} min`} label="Time assumption / item" tone="plain" /><Metric value={`${activeWorkpaper.summary.estimated_minutes_saved} min`} label="Estimated minutes saved" tone="dark" /></div>
        <div className="workpaper-layout">
          <div className="table-card"><div className="table-intro"><div><h3>Workpaper table</h3><p>Select any row to inspect its decision rationale.</p></div><span>{humanQueue.length} awaiting review</span></div><div className="table-scroll"><table><thead><tr><th>Document</th><th>Finding</th><th>Evidence</th><th>Confidence</th><th>Action</th></tr></thead><tbody>{activeWorkpaper.rows.map((row) => <WorkpaperTableRow key={row.document} row={row} isSelected={selectedRow?.document === row.document} reviewerDecision={reviewDecisions[row.document]} selectedCase={selectedCase} onSelect={setSelectedRow} />)}</tbody></table></div></div>
          <ExceptionPanel row={selectedRow} decision={selectedRow ? reviewDecisions[selectedRow.document] : undefined} reviewNote={reviewNote} onClose={() => setSelectedRow(null)} onDecision={chooseDecision} onNoteChange={setReviewNote} />
        </div>
        <p className="assumption"><Icon name="clock" size={16} /> Estimated minutes saved uses the explicit assumption of <strong>{activeWorkpaper.summary.assumed_minutes_per_item} minutes per auto-cleared item</strong>: {activeWorkpaper.summary.auto_cleared} × {activeWorkpaper.summary.assumed_minutes_per_item} = {activeWorkpaper.summary.estimated_minutes_saved} minutes.</p>
      </section>}
    </main>
  );
}

function WorkpaperTableRow({ row, isSelected, reviewerDecision, selectedCase, onSelect }: { row: WorkpaperRow; isSelected: boolean; reviewerDecision?: ReviewerDecision; selectedCase: CaseId; onSelect: (row: WorkpaperRow) => void }) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => { if (event.key === "Enter") onSelect(row); };
  return <tr className={isSelected ? "selected" : ""} onClick={() => onSelect(row)} tabIndex={0} onKeyDown={handleKeyDown}><td><strong>{row.document}</strong><small>{selectedCase === "UPLOAD" ? "Uploaded bundle" : "Demo document"}</small></td><td><span className={`finding ${row.finding === "Clean" ? "clean" : "exception"}`}>{row.finding}</span></td><td><div className="evidence-list">{row.evidence.slice(0, 3).map((item) => <span key={item}>{item}</span>)}{row.evidence.length > 3 && <span>+{row.evidence.length - 3}</span>}</div></td><td><div className="confidence"><b>{formatConfidence(row.confidence)}</b><span><i style={{ width: `${row.confidence * 100}%` }} /></span></div></td><td><span className={`action ${row.action}`}>{reviewerDecision ? reviewerDecisionCopy[reviewerDecision] : actionLabel(row.action)}</span></td></tr>;
}

function ExceptionPanel({ row, decision, reviewNote, onClose, onDecision, onNoteChange }: { row: WorkpaperRow | null; decision?: ReviewerDecision; reviewNote: string; onClose: () => void; onDecision: (decision: ReviewerDecision) => void; onNoteChange: (value: string) => void }) {
  if (!row) return <aside className="decision-panel" aria-live="polite"><div className="empty-detail"><span className="empty-icon"><Icon name="note" size={23} /></span><h3>Open an exception</h3><p>Select a workpaper row to see the finding, evidence, confidence, action, and decision rationale.</p></div></aside>;
  const detail = detailByDocument[row.document] ?? {
    reason: "No additional exception narrative is available. Review the linked evidence and the agent action before recording a decision.",
    severity: row.finding === "Clean" ? "None" : "High",
  };
  return <aside className="decision-panel" aria-live="polite"><button className="panel-close" onClick={onClose} aria-label="Close detail"><Icon name="close" size={18} /></button><p className="eyebrow">EXCEPTION DETAIL</p><h3>{row.finding}</h3><p className="detail-doc">{row.document} <span>· {detail.severity} priority</span></p><Detail label="Finding" value={row.finding} /><Detail label="Evidence" value={<div className="detail-evidence">{row.evidence.map((item) => <span key={item}>{item}</span>)}</div>} /><Detail label="Confidence" value={`${formatConfidence(row.confidence)} (${row.confidence.toFixed(2)} internally)`} /><Detail label="Agent action" value={actionLabel(row.action)} /><Detail label="Reason" value={detail.reason} /><Detail label="Involved documents" value={row.evidence.join(" · ")} /><div className="review-actions"><p>Reviewer decision</p><div><button className={decision === "cleared" ? "active-decision" : ""} onClick={() => onDecision("cleared")}>Clear exception</button><button className={decision === "evidence_requested" ? "active-decision" : ""} onClick={() => onDecision("evidence_requested")}>Request evidence</button><button className={decision === "escalated" ? "active-decision danger" : "danger"} onClick={() => onDecision("escalated")}>Escalate</button></div><label className="note-field"><span>Reviewer note <em>optional</em></span><textarea value={reviewNote} onChange={(event) => onNoteChange(event.target.value)} placeholder="Add context for the review trail…" rows={2} /></label></div></aside>;
}

function Metric({ value, label, tone }: { value: string | number; label: string; tone: "dark" | "mint" | "amber" | "coral" | "plain" }) {
  return <div className={`metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return <div className="detail-row"><span>{label}</span><div>{value}</div></div>;
}
