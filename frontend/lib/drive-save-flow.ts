// The Save to Google Drive action for a completed report: when it shows, and
// what one click does. The PDF generator and the Drive saver are imported
// only when the button is clicked, so neither they nor pdfmake are part of
// the page's first load.
//
// Saving reuses the completed run already on the page: no model call, no
// AuditFlow backend request and no access code. The PDF goes straight from
// the browser to Google through drive-report-upload.ts, which owns folder
// creation, name collisions, retries and disconnect handling.

import type { Workpaper } from "../types/workpaper";
import type { DriveSaveResult } from "./drive-report-upload";
import type { DriveState } from "./google-drive";
import { sampleCaseDocuments } from "./sample-case-documents";

/** The completed run the report is made from. */
export interface DriveSaveReport {
  readonly workpaper: Workpaper;
  readonly completedAt: Date;
  /** The app's Company name field, or null when it doesn't apply. */
  readonly companyName: string | null;
}

/**
 * Shown only when the Drive feature flag is on (isDriveConfigured()), Drive
 * is connected and a run has completed with real results.
 */
export function showsDriveSave(options: {
  readonly driveConfigured: boolean;
  readonly driveState: DriveState;
  readonly hasCompletedReport: boolean;
}): boolean {
  return options.driveConfigured && options.driveState === "connected" && options.hasCompletedReport;
}

export type DriveSaveTone = "ok" | "warning" | "problem";

export interface DriveSaveNotice {
  readonly tone: DriveSaveTone;
  readonly text: string;
}

const NOT_PREPARED = "The report couldn't be prepared for Google Drive. Try again.";

/** What to tell the user about a save. The saver's messages are already safe to show. */
export function noticeFor(result: DriveSaveResult): DriveSaveNotice {
  switch (result.status) {
    case "saved":
      return { tone: "ok", text: result.message };
    case "uncertain":
      return { tone: "warning", text: `Upload not confirmed. ${result.message}` };
    case "failed":
      return { tone: "problem", text: result.message };
  }
}

export interface DriveSaveModules {
  readonly loadGenerator: () => Promise<Pick<typeof import("./report-pdf"), "generateReportPdf" | "reportPdfFileNameFor">>;
  readonly loadSaver: () => Promise<Pick<typeof import("./drive-report-upload"), "getDriveReportSaver">>;
}

const lazyModules: DriveSaveModules = {
  loadGenerator: () => import("./report-pdf"),
  loadSaver: () => import("./drive-report-upload"),
};

/** Makes the PDF from the completed run and saves it to Drive. Never throws. */
export async function saveReportToDrive(
  report: DriveSaveReport,
  modules: DriveSaveModules = lazyModules,
): Promise<DriveSaveNotice> {
  let pdf: Uint8Array;
  let fileName: string;
  let save: (typeof import("./drive-report-upload"))["getDriveReportSaver"];
  try {
    const [generator, saver] = await Promise.all([modules.loadGenerator(), modules.loadSaver()]);
    pdf = await generator.generateReportPdf({
      workpaper: report.workpaper,
      completedAt: report.completedAt,
      companyName: report.companyName,
      // A sample case's full file list, so the report names every source
      // document and not only those its findings cite. An upload run's own
      // uploaded-file list takes precedence inside the generator.
      sourceDocuments: sampleCaseDocuments(report.workpaper.case_id),
    });
    // Named from the run itself, so an upload run (which the backend gives
    // a CASE_<digits> ID) is named "Uploaded-documents", not after that ID.
    fileName = generator.reportPdfFileNameFor(report.workpaper, report.completedAt);
    save = saver.getDriveReportSaver;
  } catch {
    // The report data was rejected or the code couldn't load. Nothing was sent.
    return { tone: "problem", text: NOT_PREPARED };
  }
  try {
    return noticeFor(
      await save().save({ pdf, fileName, companyName: report.companyName, completedAt: report.completedAt }),
    );
  } catch {
    // The saver reports outcomes as results; this is only a safety net.
    return { tone: "warning", text: "Upload not confirmed. Check your AuditFlow folder in Google Drive before saving again." };
  }
}

export type DriveSavePhase = "idle" | "saving";

/** One save at a time from the button: clicks while saving start nothing. */
export class DriveSaveFlow {
  private phase: DriveSavePhase = "idle";
  private notice: DriveSaveNotice | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly run: (report: DriveSaveReport) => Promise<DriveSaveNotice> = saveReportToDrive) {}

  getPhase(): DriveSavePhase {
    return this.phase;
  }

  getNotice(): DriveSaveNotice | null {
    return this.notice;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves to the notice, or null when a save was already running. */
  async start(report: DriveSaveReport): Promise<DriveSaveNotice | null> {
    if (this.phase === "saving") return null;
    this.phase = "saving";
    this.notice = null;
    this.emit();
    try {
      this.notice = await this.run(report);
    } finally {
      this.phase = "idle";
      this.emit();
    }
    return this.notice;
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
