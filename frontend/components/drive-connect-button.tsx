"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getDriveSession,
  isDriveConfigured,
  loadGoogleOAuth2,
  type ConnectOutcome,
  type DisconnectOutcome,
  type DriveState,
} from "../lib/google-drive";

const GOOGLE_CONNECTIONS_URL = "https://myaccount.google.com/connections";
const NOTICE_MS = 8000;

const connectMessages: Record<Exclude<ConnectOutcome, "connected">, string> = {
  scope_denied: "Google Drive access wasn't allowed, so AuditFlow can't use Drive.",
  cancelled: "Google Drive wasn't connected.",
  popup_blocked: "Your browser blocked Google's window. Allow pop-ups for this site and try again.",
  failed: "Google Drive couldn't be connected. Try again.",
  not_configured: "Google Drive isn't set up on this site.",
};

const disconnectMessages: Record<DisconnectOutcome, string> = {
  revoked: "Google Drive disconnected. AuditFlow's access was removed.",
  already_invalid: "Google Drive disconnected. Google had already ended this access.",
  unconfirmed: "Disconnected here, but Google didn't confirm that access was removed.",
};

// The verb shown before "Google Drive"; narrow screens drop "Google".
const buttonVerb: Record<Exclude<DriveState, "connecting">, string> = {
  disconnected: "Connect",
  connected: "Disconnect",
  expired: "Reconnect",
};

interface Notice {
  readonly text: string;
  readonly problem: boolean;
  readonly showGoogleLink: boolean;
}

const subscribe = (listener: () => void) => getDriveSession().subscribe(listener);
const getSnapshot = () => getDriveSession().getState();
const getServerSnapshot = (): DriveState => "disconnected";

// One button that connects, disconnects or reconnects Google Drive for this
// tab. Hidden unless the three NEXT_PUBLIC_GOOGLE_* values are set.
export function DriveConnectButton() {
  if (!isDriveConfigured()) return null;
  return <DriveConnectControl />;
}

function DriveConnectControl() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Load Google's script ahead of the click, so the popup opens straight from
  // the click and isn't blocked.
  useEffect(() => {
    void loadGoogleOAuth2().catch(() => {});
  }, []);

  // A notice is a passing confirmation; the button label carries the state.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const connect = async () => {
    setNotice(null);
    const outcome = await getDriveSession().connect();
    setNotice(
      outcome === "connected"
        ? { text: "Google Drive connected for this tab.", problem: false, showGoogleLink: false }
        : { text: connectMessages[outcome], problem: true, showGoogleLink: false },
    );
  };

  const disconnect = async () => {
    const confirmed = window.confirm(
      "Disconnect Google Drive? AuditFlow will stop using your Drive and ask Google to remove its access. You can connect again later.",
    );
    if (!confirmed) return;
    const outcome = await getDriveSession().disconnect();
    setNotice({
      text: disconnectMessages[outcome],
      problem: outcome === "unconfirmed",
      showGoogleLink: outcome === "unconfirmed",
    });
  };

  const onClick = () => void (state === "connected" ? disconnect() : connect());
  const expired = state === "expired";

  return (
    <div className="drive-connect">
      <button
        type="button"
        className={`drive-connect-toggle${state === "connected" ? " connected" : ""}`}
        onClick={onClick}
        disabled={state === "connecting"}
        aria-label={state === "connecting" ? undefined : `${buttonVerb[state]} Google Drive`}
        aria-describedby="drive-connect-status"
      >
        {state === "connecting" ? (
          "Connecting…"
        ) : (
          <>
            {buttonVerb[state]} <span className="drive-connect-wide">Google </span>Drive
          </>
        )}
      </button>
      <p
        id="drive-connect-status"
        className={`drive-connect-status${notice?.problem || expired ? " problem" : ""}`}
        role="status"
      >
        {expired ? "Google Drive access expired. Reconnect to keep using Drive." : notice?.text}
        {!expired && notice?.showGoogleLink && (
          <>
            {" "}
            <a href={GOOGLE_CONNECTIONS_URL} target="_blank" rel="noopener noreferrer">
              Check your Google Account
            </a>
          </>
        )}
      </p>
    </div>
  );
}
