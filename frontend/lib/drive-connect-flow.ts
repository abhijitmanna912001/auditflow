// What the header's Google Drive button tells the user, and the steps of
// disconnecting. Success needs no message: the button's label already shows
// whether Drive is connected. Only problems, and the one outcome that
// changes what the user should expect, are reported.

import type { ConnectOutcome, DisconnectOutcome } from "./google-drive";

export interface Notice {
  readonly text: string;
  readonly problem: boolean;
  readonly showGoogleLink: boolean;
}

const connectProblems: Record<Exclude<ConnectOutcome, "connected">, string> = {
  scope_denied: "Google Drive access wasn't allowed, so AuditFlow can't use Drive.",
  cancelled: "Google Drive wasn't connected.",
  popup_blocked: "Your browser blocked Google's window. Allow pop-ups for this site and try again.",
  failed: "Google Drive couldn't be connected. Try again.",
  not_configured: "Google Drive isn't set up on this site.",
};

export function connectNotice(outcome: ConnectOutcome): Notice | null {
  if (outcome === "connected") return null;
  return { text: connectProblems[outcome], problem: true, showGoogleLink: false };
}

export function disconnectNotice(outcome: DisconnectOutcome): Notice | null {
  switch (outcome) {
    case "revoked":
      return null;
    case "already_invalid":
      return {
        text: "Google Drive disconnected. Google had already ended this access.",
        problem: false,
        showGoogleLink: false,
      };
    case "unconfirmed":
      return {
        text: "Disconnected here, but Google didn't confirm that access was removed.",
        problem: true,
        showGoogleLink: true,
      };
  }
}

// How long a passing connect or disconnect message stays on screen.
export const NOTICE_MS = 6000;

// The passing message from the last connect or disconnect attempt, shown in
// the message area below the page header. It goes away by itself after
// NOTICE_MS, when the user closes it, or when a newer one replaces it.
// Lasting states, such as expired access, are not notices: they come from
// the Drive session and stay until resolved.
export class NoticeBoard {
  private notice: Notice | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly showMs = NOTICE_MS) {}

  get(): Notice | null {
    return this.notice;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Shows a notice (replacing any other), or clears it when null.
  show(notice: Notice | null): void {
    this.clearTimer();
    if (notice) this.timer = setTimeout(() => this.dismiss(), this.showMs);
    if (this.notice === notice) return;
    this.notice = notice;
    this.emit();
  }

  dismiss(): void {
    this.show(null);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

let driveNotices: NoticeBoard | null = null;

// The one notice board for this tab, shared by the header button and the
// message area.
export function getDriveNotices(): NoticeBoard {
  driveNotices ??= new NoticeBoard();
  return driveNotices;
}

export type DisconnectPhase = "closed" | "confirming" | "disconnecting";

// Disconnecting asks first, in AuditFlow's own dialog. Cancel changes
// nothing; confirming runs the session's disconnect once, however often the
// button is pressed while it runs.
export class DisconnectFlow {
  private phase: DisconnectPhase = "closed";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly disconnect: () => Promise<DisconnectOutcome>) {}

  getPhase(): DisconnectPhase {
    return this.phase;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  request(): void {
    if (this.phase === "closed") this.setPhase("confirming");
  }

  // Ignored once disconnecting has started: it can't be undone part-way.
  cancel(): void {
    if (this.phase === "confirming") this.setPhase("closed");
  }

  // Resolves to the outcome, or null when nothing was started because the
  // dialog wasn't open or a disconnect was already running.
  async confirm(): Promise<DisconnectOutcome | null> {
    if (this.phase !== "confirming") return null;
    this.setPhase("disconnecting");
    try {
      return await this.disconnect();
    } catch {
      return "unconfirmed";
    } finally {
      this.setPhase("closed");
    }
  }

  private setPhase(phase: DisconnectPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.listeners.forEach((listener) => listener());
  }
}
