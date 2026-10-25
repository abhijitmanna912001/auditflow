"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  DriveSaveFlow,
  showsDriveSave,
  type DriveSaveNotice,
  type DriveSavePhase,
  type DriveSaveReport,
} from "../lib/drive-save-flow";
import { isDriveConfigured } from "../lib/google-drive";
import { useDriveState } from "./drive-file-picker";
import { Icon } from "./icons";

const getServerPhase = (): DriveSavePhase => "idle";
const getServerNotice = (): DriveSaveNotice | null => null;

interface DriveSaveButtonProps {
  /** The completed run, or null when there is no report to save. */
  readonly report: DriveSaveReport | null;
}

// Saves the completed report as a PDF in the user's Google Drive. Separate
// from Save PDF report, which keeps using the browser's print window.
export function DriveSaveButton({ report }: DriveSaveButtonProps) {
  const driveState = useDriveState();
  const [flow] = useState(() => new DriveSaveFlow());
  const subscribe = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const phase = useSyncExternalStore(subscribe, () => flow.getPhase(), getServerPhase);
  const notice = useSyncExternalStore(subscribe, () => flow.getNotice(), getServerNotice);
  const visible = showsDriveSave({
    driveConfigured: isDriveConfigured(),
    driveState,
    hasCompletedReport: report !== null,
  });
  return (
    <DriveSaveView
      visible={visible}
      saving={phase === "saving"}
      notice={notice}
      onSave={() => {
        if (report) void flow.start(report);
      }}
    />
  );
}

interface DriveSaveViewProps {
  readonly visible: boolean;
  readonly saving: boolean;
  readonly notice: DriveSaveNotice | null;
  readonly onSave: () => void;
}

const noticeClass: Record<DriveSaveNotice["tone"], string> = {
  ok: "send-message ok",
  warning: "send-notice",
  problem: "send-message problem",
};

// The button and the outcome of the last save. A save's outcome stays on
// screen even if Drive is disconnected meanwhile and the button goes away.
export function DriveSaveView({ visible, saving, notice, onSave }: DriveSaveViewProps) {
  if (!visible && !saving && !notice) return null;
  return (
    <div className="report-action drive-save-action">
      {(visible || saving) && (
        <>
          <button
            type="button"
            className="secondary-button"
            onClick={saving ? undefined : onSave}
            disabled={saving}
            aria-busy={saving}
          >
            <Icon name="upload" size={15} />
            <span>{saving ? "Saving to Google Drive…" : "Save to Google Drive"}</span>
          </button>
          <small>Saves the PDF report to the AuditFlow folder in your Google Drive.</small>
        </>
      )}
      {notice && (
        <p className={noticeClass[notice.tone]} role={notice.tone === "ok" ? "status" : "alert"}>
          {notice.text}
        </p>
      )}
    </div>
  );
}
