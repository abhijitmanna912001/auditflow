import type { ReactNode } from "react";

export const SAVE_PDF_HINT_ID = "save-pdf-hint";

interface ResultsActionsProps {
  /** Save PDF report, or null when there is no report to print. */
  readonly savePdf: ReactNode;
  /** Save to Google Drive, or null when it doesn't show. */
  readonly driveSave: ReactNode;
  /** Send all findings to Zoho Desk, or null when it doesn't show. */
  readonly sendAll: ReactNode;
  /** One short line of help below the row, or null. */
  readonly caption?: ReactNode;
  /** Outcome messages, below the caption, or null. */
  readonly status?: ReactNode;
}

// The results' actions, always in this order: Save PDF report, Save to
// Google Drive, Send all findings to Zoho Desk. One row, right-aligned on
// wide screens and wrapping on narrow ones; the help line and any messages
// sit below the row so the buttons line up.
export function ResultsActions({ savePdf, driveSave, sendAll, caption, status }: ResultsActionsProps) {
  if (!savePdf && !driveSave && !sendAll && !status) return null;
  return (
    <div className="results-actions-area">
      <div className="results-actions" role="group" aria-label="Report actions">
        {savePdf}
        {driveSave}
        {sendAll}
      </div>
      {caption ? <p className="results-actions-hint">{caption}</p> : null}
      {status}
    </div>
  );
}
