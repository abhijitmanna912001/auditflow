"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
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

export const DRIVE_SAVE_HINT_ID = "drive-save-hint";
export const DRIVE_SAVE_HINT = "Save to Google Drive saves the PDF in the AuditFlow folder in your Drive.";

const getServerPhase = (): DriveSavePhase => "idle";
const getServerNotice = (): DriveSaveNotice | null => null;

/** Everything the results area needs to show Save to Google Drive. */
export interface DriveSaveControl {
  /** The button shows: Drive is set up and connected, and a report is complete. */
  readonly visible: boolean;
  readonly saving: boolean;
  /** The last save's outcome. Kept if Drive disconnects afterwards. */
  readonly notice: DriveSaveNotice | null;
  readonly save: () => void;
}

/**
 * Save to Google Drive for the completed run. `runKey` identifies the run:
 * a new run starts with no message. Saving itself (generating the PDF and
 * uploading it) is loaded only when the button is clicked.
 */
export function useDriveSave(report: DriveSaveReport | null, runKey: string | number): DriveSaveControl {
  const driveState = useDriveState();
  const flow = useMemo(() => new DriveSaveFlow(), [runKey]);
  const subscribe = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const phase = useSyncExternalStore(subscribe, () => flow.getPhase(), getServerPhase);
  const notice = useSyncExternalStore(subscribe, () => flow.getNotice(), getServerNotice);
  return {
    visible: showsDriveSave({
      driveConfigured: isDriveConfigured(),
      driveState,
      hasCompletedReport: report !== null,
    }),
    saving: phase === "saving",
    notice,
    save: () => {
      if (report) void flow.start(report);
    },
  };
}

/** Whether the button is on screen (it stays while a save runs). */
export const showsDriveSaveAction = (control: DriveSaveControl) => control.visible || control.saving;

/** Whether the message area is on screen. */
export const showsDriveSaveStatus = (control: DriveSaveControl) =>
  showsDriveSaveAction(control) || control.notice !== null;

interface DriveSaveProps {
  readonly control: DriveSaveControl;
}

// The Save to Google Drive button, for the results action row. Disabled and
// marked busy while saving, so repeated clicks start nothing.
export function DriveSaveAction({ control }: DriveSaveProps) {
  if (!showsDriveSaveAction(control)) return null;
  const { saving, save } = control;
  return (
    <button
      type="button"
      className="secondary-button"
      onClick={saving ? undefined : save}
      disabled={saving}
      aria-busy={saving}
      aria-describedby={DRIVE_SAVE_HINT_ID}
    >
      <Icon name="upload" size={15} />
      <span>{saving ? "Saving to Google Drive…" : "Save to Google Drive"}</span>
    </button>
  );
}

const SAVING_TEXT = "Saving the report to Google Drive…";

// One message area below the action row for every save outcome. It is a
// single polite status region, there before a save starts, so each message
// is announced once. Messages are left-aligned and long file names and
// folder paths wrap.
export function DriveSaveStatus({ control }: DriveSaveProps) {
  if (!showsDriveSaveStatus(control)) return null;
  const { saving, notice } = control;
  return (
    <div className="drive-save-status" role="status" aria-live="polite" aria-atomic="true">
      {saving ? (
        <p className="status-message saving">{SAVING_TEXT}</p>
      ) : notice ? (
        <p className={`status-message ${notice.tone}`}>{notice.text}</p>
      ) : null}
    </div>
  );
}
