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
