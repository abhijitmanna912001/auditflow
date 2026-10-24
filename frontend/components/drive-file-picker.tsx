"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  MAX_FILES_PER_RUN,
  summarizeSelection,
  type ImportedFile,
  type SelectionSummary,
} from "../lib/drive-files";
import {
  getDriveConfig,
  getDriveSession,
  isDriveConfigured,
  type DriveState,
} from "../lib/google-drive";
import { loadPickerApi, selectDriveFiles } from "../lib/google-picker";

const subscribe = (listener: () => void) => getDriveSession().subscribe(listener);
const getSnapshot = () => getDriveSession().getState();
const getServerSnapshot = (): DriveState => "disconnected";

export function useDriveState(): DriveState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const PICKER_FAILED: SelectionSummary = {
  headline: "Google Drive's file picker couldn't load. Check your connection and try again.",
  details: [],
  problem: true,
};

interface DriveFilePickerProps {
  readonly existingCount: number;
  readonly existingIds: ReadonlySet<string>;
  readonly disabled: boolean;
  // Progress text while working, or null when idle.
  readonly onBusy: (text: string | null) => void;
  readonly onDone: (files: readonly ImportedFile[], summary: SelectionSummary | null) => void;
}

// "Select from Google Drive", next to Upload documents. Hidden unless Drive
// is configured; usable only once Drive is connected at the top of the page.
export function DriveFilePicker(props: DriveFilePickerProps) {
  if (!isDriveConfigured()) return null;
  return <DriveFilePickerControl {...props} />;
}

function DriveFilePickerControl({
  existingCount,
  existingIds,
  disabled,
  onBusy,
  onDone,
}: DriveFilePickerProps) {
  const state = useDriveState();
  const [working, setWorking] = useState(false);
  const connected = state === "connected";
  const blocked = !connected || disabled || working;

  // Load the Picker once Drive is connected, so the click opens it quickly.
  useEffect(() => {
    if (connected) void loadPickerApi().catch(() => {});
  }, [connected]);

  const select = async () => {
    if (blocked) return;
    const session = getDriveSession();
    const { apiKey, appId } = getDriveConfig();
    setWorking(true);
    onBusy("Opening Google Drive…");
    let disconnected = false;
    const stopWatching = session.onDisconnect(() => {
      disconnected = true;
    });
    try {
      const selection = await selectDriveFiles({
        apiKey,
        appId,
        existingCount,
        existingIds,
        wasDisconnected: () => disconnected,
        getToken: () => session.getAccessToken(),
        onTokenRejected: (token) => session.markTokenRejected(token),
        onPicked: (count) => onBusy(`Checking ${count} file${count === 1 ? "" : "s"} from Google Drive…`),
        onProgress: ({ current, total, name }) =>
          onBusy(`Downloading ${current} of ${total} from Google Drive: ${name}`),
      });
      switch (selection.kind) {
        case "imported": {
          const { accepted, skipped } = selection.result;
          onDone(accepted, summarizeSelection("drive", accepted.length, skipped, existingCount));
          break;
        }
        case "cancelled":
          onDone([], null);
          break;
        case "full":
          onDone([], {
            headline: `This check already has ${MAX_FILES_PER_RUN} files, the most allowed. Choose a sample case to start over.`,
            details: [],
            problem: true,
          });
          break;
        case "not_connected":
          onDone([], {
            headline: "Google Drive isn't connected. Connect Google Drive at the top of the page, then try again.",
            details: [],
            problem: true,
          });
          break;
        case "picker_failed":
          onDone([], PICKER_FAILED);
          break;
        case "disconnected":
          onDone([], {
            headline: "Google Drive was disconnected, so no files were added from Drive.",
            details: [],
            problem: true,
          });
          break;
      }
    } catch {
      onDone([], PICKER_FAILED);
    } finally {
      stopWatching();
      setWorking(false);
      onBusy(null);
    }
  };

  return (
    <button
      type="button"
      className="upload-button drive-select-button"
      onClick={() => void select()}
      aria-disabled={blocked}
      aria-describedby="drive-select-hint"
    >
      {working ? <span className="spinner dark" /> : <DriveIcon />}
      <span>{working ? "Working…" : "Select from Google Drive"}</span>
    </button>
  );
}

// Why the button can't be used yet, or null when it can.
export function driveSelectHint(state: DriveState): string | null {
  if (state === "connected") return null;
  if (state === "expired") {
    return "Google Drive access expired. Reconnect Google Drive at the top of the page to select files from Drive.";
  }
  if (state === "connecting") return "Connecting Google Drive…";
  return "To select files from Google Drive, connect Google Drive at the top of the page first.";
}

function DriveIcon() {
  return (
    <svg className="icon" width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 4h7l5.5 9.5-3.5 6h-11L3 13.5 8.5 4Z" />
      <path d="m8.5 4 5.5 9.5H3M15.5 4 10 13.5M21 13.5h-7l-3.5 6" />
    </svg>
  );
}
