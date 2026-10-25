"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  connectNotice,
  disconnectNotice,
  DisconnectFlow,
  getDriveNotices,
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
export const DRIVE_EXPIRED_TEXT = "Google Drive access expired. Reconnect to keep using Drive.";

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
const subscribeNotices = (listener: () => void) => getDriveNotices().subscribe(listener);
const getNotice = () => getDriveNotices().get();
const getServerNotice = (): Notice | null => null;

// One button that connects, disconnects or reconnects Google Drive for this
// tab. Hidden unless the three NEXT_PUBLIC_GOOGLE_* values are set.
export function DriveConnectButton() {
  if (!isDriveConfigured()) return null;
  return <DriveConnectControl />;
}

function DriveConnectControl() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const notices = getDriveNotices();
  const [flow] = useState(() => new DisconnectFlow(() => getDriveSession().disconnect()));
  const subscribeFlow = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const phase = useSyncExternalStore(subscribeFlow, () => flow.getPhase(), getServerPhase);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Load Google's script ahead of the click, so the popup opens straight from
  // the click and isn't blocked.
  useEffect(() => {
    void loadGoogleOAuth2().catch(() => {});
  }, []);

  // A notice is a passing message about a problem, shown below the page
  // header (DriveConnectMessages); the button label carries the state.
  const connect = async () => {
    notices.dismiss();
    notices.show(connectNotice(await getDriveSession().connect()));
  };

  const confirmDisconnect = async () => {
    const outcome = await flow.confirm();
    if (outcome) notices.show(disconnectNotice(outcome));
  };

  const onClick = () => {
    if (state === "connected") {
      notices.dismiss();
      flow.request();
    } else {
      void connect();
    }
  };

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
      <DisconnectDialog
        phase={phase}
        onCancel={() => flow.cancel()}
        onConfirm={() => void confirmDisconnect()}
        returnFocusTo={toggleRef}
      />
    </div>
  );
}

// The message area below the page header for Google Drive: expired access,
// which stays until the user reconnects or disconnects, and the passing
// message from the last connect or disconnect attempt, which closes by
// itself after a few seconds or with its close button. In the page flow, so
// it never sits on the header buttons, the access code panel or the header's
// divider. Hidden unless Drive is set up.
export function DriveConnectMessages() {
  if (!isDriveConfigured()) return null;
  return <DriveConnectMessageArea />;
}

function DriveConnectMessageArea() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const notice = useSyncExternalStore(subscribeNotices, getNotice, getServerNotice);
  const expired = state === "expired";
  const { areaRef, clearance } = useClearOfAccessPanel(expired || notice !== null);
  return (
    <DriveConnectMessageView
      expired={expired}
      notice={notice}
      onDismiss={() => getDriveNotices().dismiss()}
      areaRef={areaRef}
      clearance={clearance}
    />
  );
}

// Space kept between the open Access code panel and the messages below it.
const PANEL_GAP = 8;

/**
 * How far the messages must move down so they start below the Access code
 * panel, or 0 when the panel is closed or wouldn't cover them. The panel
 * is a popover over the top of the page; rather than be hidden under it,
 * the messages make room for it while it is open.
 */
export function clearanceBelowPanel(
  area: { readonly top: number; readonly left: number; readonly right: number },
  panel: { readonly bottom: number; readonly left: number; readonly right: number } | null,
  gap = PANEL_GAP,
): number {
  if (!panel || panel.right <= area.left || panel.left >= area.right) return 0;
  return Math.max(0, Math.ceil(panel.bottom + gap - area.top));
}

// While messages show, keeps them clear of the Access code panel: measured
// when the panel opens, closes or changes size, and when the window does.
function useClearOfAccessPanel(active: boolean) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    const area = areaRef.current;
    const control = document.querySelector(".access-code");
    if (!active || !area || !control) {
      setClearance(0);
      return;
    }
    const measure = () => {
      const panel = document.getElementById("access-code-panel");
      // The spacer sits inside the area, so the area's own top never moves.
      setClearance(clearanceBelowPanel(area.getBoundingClientRect(), panel?.getBoundingClientRect() ?? null));
    };
    measure();
    const changes = new MutationObserver(measure);
    changes.observe(control, { childList: true, subtree: true, characterData: true });
    const resizes = new ResizeObserver(measure);
    resizes.observe(area);
    window.addEventListener("resize", measure);
    return () => {
      changes.disconnect();
      resizes.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return { areaRef, clearance };
}

interface DriveConnectMessageViewProps {
  readonly expired: boolean;
  readonly notice: Notice | null;
  readonly onDismiss: () => void;
  readonly areaRef?: Ref<HTMLDivElement>;
  /** Room to leave above the messages for the open Access code panel. */
  readonly clearance?: number;
}

export function DriveConnectMessageView({
  expired,
  notice,
  onDismiss,
  areaRef,
  clearance = 0,
}: DriveConnectMessageViewProps) {
  const visible = expired || notice !== null;
  return (
    <div ref={areaRef} className={`drive-connect-messages${visible ? " has-messages" : ""}`}>
      {visible && clearance > 0 && (
        <div className="drive-connect-messages-spacer" aria-hidden="true" style={{ height: clearance }} />
      )}
      {/* Read out once by screen readers, and the header button's
          description. The boxes below are what everyone sees. */}
      <p id="drive-connect-status" className="sr-only" role="status" aria-live="polite">
        {[expired ? DRIVE_EXPIRED_TEXT : null, notice?.text].filter(Boolean).join(" ")}
      </p>
      {expired && (
        <div className="status-message problem">
          <p>{DRIVE_EXPIRED_TEXT}</p>
        </div>
      )}
      {notice && (
        <div className={`status-message dismissible ${notice.problem ? "problem" : "ok"}`}>
          <p>
            {notice.text}
            {notice.showGoogleLink && (
              <>
                {" "}
                <a href={GOOGLE_CONNECTIONS_URL} target="_blank" rel="noopener noreferrer">
                  Check your Google Account
                </a>
              </>
            )}
          </p>
          <button
            type="button"
            className="status-message-close"
            aria-label="Close this Google Drive message"
            onClick={onDismiss}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
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
            aria-label={busy ? undefined : "Disconnect Google Drive"}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
