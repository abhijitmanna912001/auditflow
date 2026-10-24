"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  connectNotice,
  disconnectNotice,
  DisconnectFlow,
  type DisconnectPhase,
  type Notice,
} from "../lib/drive-connect-flow";
import {
  getDriveSession,
  isDriveConfigured,
  loadGoogleOAuth2,
  type DriveState,
} from "../lib/google-drive";

const GOOGLE_CONNECTIONS_URL = "https://myaccount.google.com/connections";
const NOTICE_MS = 8000;

// The verb shown before "Google Drive"; narrow screens drop "Google".
const buttonVerb: Record<Exclude<DriveState, "connecting">, string> = {
  disconnected: "Connect",
  connected: "Disconnect",
  expired: "Reconnect",
};

const subscribe = (listener: () => void) => getDriveSession().subscribe(listener);
const getSnapshot = () => getDriveSession().getState();
const getServerSnapshot = (): DriveState => "disconnected";
const getServerPhase = (): DisconnectPhase => "closed";

// One button that connects, disconnects or reconnects Google Drive for this
// tab. Hidden unless the three NEXT_PUBLIC_GOOGLE_* values are set.
export function DriveConnectButton() {
  if (!isDriveConfigured()) return null;
  return <DriveConnectControl />;
}

function DriveConnectControl() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [flow] = useState(() => new DisconnectFlow(() => getDriveSession().disconnect()));
  const subscribeFlow = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const phase = useSyncExternalStore(subscribeFlow, () => flow.getPhase(), getServerPhase);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Load Google's script ahead of the click, so the popup opens straight from
  // the click and isn't blocked.
  useEffect(() => {
    void loadGoogleOAuth2().catch(() => {});
  }, []);

  // A notice is a passing message about a problem; the button label carries
  // the state.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const connect = async () => {
    setNotice(null);
    setNotice(connectNotice(await getDriveSession().connect()));
  };

  const confirmDisconnect = async () => {
    const outcome = await flow.confirm();
    if (outcome) setNotice(disconnectNotice(outcome));
  };

  const onClick = () => {
    if (state === "connected") {
      setNotice(null);
      flow.request();
    } else {
      void connect();
    }
  };
  const expired = state === "expired";

  return (
    <div className="drive-connect">
      <button
        ref={toggleRef}
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
      <DisconnectDialog
        phase={phase}
        onCancel={() => flow.cancel()}
        onConfirm={() => void confirmDisconnect()}
        returnFocusTo={toggleRef}
      />
    </div>
  );
}

interface DisconnectDialogProps {
  readonly phase: DisconnectPhase;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly returnFocusTo: RefObject<HTMLButtonElement | null>;
}

// AuditFlow's own confirmation, in place of the browser's built-in one. A modal
// <dialog> keeps focus inside it and the page behind it inert; Escape and a
// click outside count as Cancel. Focus starts on Cancel, the safe choice, and
// returns to the header button afterwards.
function DisconnectDialog({ phase, onCancel, onConfirm, returnFocusTo }: DisconnectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = phase === "disconnecting";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (phase !== "closed" && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (phase === "closed" && dialog.open) {
      dialog.close();
      returnFocusTo.current?.focus();
    }
  }, [phase, returnFocusTo]);

  // Escape: never let the browser close it behind the flow's back.
  const handleCancelEvent = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onCancel();
  };

  // A click on the backdrop lands on the dialog element itself.
  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="drive-disconnect-dialog"
      role="alertdialog"
      aria-labelledby="drive-disconnect-title"
      aria-describedby="drive-disconnect-body"
      aria-busy={busy}
      onCancel={handleCancelEvent}
      onClick={handleClick}
    >
      <div className="drive-disconnect-content">
        <h2 id="drive-disconnect-title">Disconnect Google Drive?</h2>
        <div id="drive-disconnect-body">
          <p>
            AuditFlow will stop using your Google Drive in this tab and ask Google to remove its
            access.
          </p>
          <p>
            Files added from Drive will be removed from this check, along with any results that
            used them. You can connect again later.
          </p>
        </div>
        <div className="drive-disconnect-actions">
          <button
            ref={cancelRef}
            type="button"
            className="access-code-btn access-code-btn-outline"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="access-code-btn access-code-btn-solid"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Disconnecting…" : "Disconnect Google Drive"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
