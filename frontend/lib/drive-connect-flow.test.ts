import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clearanceBelowPanel, DriveConnectMessageView } from "../components/drive-connect-button";
import {
  connectNotice,
  DisconnectFlow,
  disconnectNotice,
  getDriveNotices,
  NOTICE_MS,
  NoticeBoard,
  type Notice,
} from "./drive-connect-flow";
import type { DisconnectOutcome } from "./google-drive";

// A disconnect that only finishes when the test says so.
function pendingDisconnect() {
  let finish: (outcome: DisconnectOutcome) => void = () => {};
  const disconnect = vi.fn(() => new Promise<DisconnectOutcome>((resolve) => (finish = resolve)));
  return { disconnect, finish: (outcome: DisconnectOutcome) => finish(outcome) };
}

describe("connect notices", () => {
  it("shows nothing after a successful connection", () => {
    expect(connectNotice("connected")).toBeNull();
  });

  it.each([
    ["scope_denied", "Google Drive access wasn't allowed, so AuditFlow can't use Drive."],
    ["cancelled", "Google Drive wasn't connected."],
    ["popup_blocked", "Your browser blocked Google's window. Allow pop-ups for this site and try again."],
    ["failed", "Google Drive couldn't be connected. Try again."],
    ["not_configured", "Google Drive isn't set up on this site."],
  ] as const)("still explains %s", (outcome, text) => {
    expect(connectNotice(outcome)).toEqual({ text, problem: true, showGoogleLink: false });
  });
});

describe("disconnect notices", () => {
  it("shows nothing after access was removed", () => {
    expect(disconnectNotice("revoked")).toBeNull();
  });

  it("still warns, with a link to the Google Account, when Google didn't confirm removal", () => {
    expect(disconnectNotice("unconfirmed")).toEqual({
      text: "Disconnected here, but Google didn't confirm that access was removed.",
      problem: true,
      showGoogleLink: true,
    });
  });

  it("still says when Google had already ended access", () => {
    expect(disconnectNotice("already_invalid")).toEqual({
      text: "Google Drive disconnected. Google had already ended this access.",
      problem: false,
      showGoogleLink: false,
    });
  });
});

describe("disconnect confirmation", () => {
  it("opens without disconnecting", () => {
    const { disconnect } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    flow.request();
    expect(flow.getPhase()).toBe("confirming");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("Cancel closes it and leaves Drive connected", async () => {
    const { disconnect } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    flow.request();
    flow.cancel();
    expect(flow.getPhase()).toBe("closed");
    expect(await flow.confirm()).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("confirming runs the existing disconnect and reports its outcome", async () => {
    const { disconnect, finish } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    flow.request();
    const result = flow.confirm();
    expect(flow.getPhase()).toBe("disconnecting");
    finish("revoked");
    expect(await result).toBe("revoked");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(flow.getPhase()).toBe("closed");
  });

  it("runs only one disconnect however often it is confirmed", async () => {
    const { disconnect, finish } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    flow.request();
    const first = flow.confirm();
    const second = flow.confirm();
    flow.request();
    flow.cancel();
    expect(flow.getPhase()).toBe("disconnecting");
    finish("revoked");
    expect(await first).toBe("revoked");
    expect(await second).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("passes on a failed access removal so the warning still shows", async () => {
    const { disconnect, finish } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    flow.request();
    const result = flow.confirm();
    finish("unconfirmed");
    const outcome = await result;
    expect(outcome).toBe("unconfirmed");
    expect(disconnectNotice(outcome!)?.problem).toBe(true);
  });

  it("treats an unexpected error as unconfirmed and closes", async () => {
    const flow = new DisconnectFlow(() => Promise.reject(new Error("boom")));
    flow.request();
    expect(await flow.confirm()).toBe("unconfirmed");
    expect(flow.getPhase()).toBe("closed");
  });

  it("does nothing when confirmed without being opened", async () => {
    const { disconnect } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    expect(await flow.confirm()).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("tells subscribers about each step", async () => {
    const { disconnect, finish } = pendingDisconnect();
    const flow = new DisconnectFlow(disconnect);
    const seen: string[] = [];
    flow.subscribe(() => seen.push(flow.getPhase()));
    flow.request();
    const result = flow.confirm();
    finish("revoked");
    await result;
    expect(seen).toEqual(["confirming", "disconnecting", "closed"]);
  });
});

describe("header button source", () => {
  const source = readFileSync(new URL("../components/drive-connect-button.tsx", import.meta.url), "utf-8");

  it("no longer uses the browser's confirm dialog", () => {
    // A bare confirm() call; the flow's own flow.confirm() is fine.
    expect(source).not.toMatch(/(?<![.\w])confirm\(/);
    expect(source).not.toMatch(/window\.(confirm|alert|prompt)/);
  });

  it("no longer shows connect or disconnect success messages", () => {
    expect(source).not.toContain("connected for this tab");
    expect(source).not.toContain("access was removed.");
  });

  it("uses a labelled modal dialog with Cancel and Disconnect", () => {
    expect(source).toContain("showModal()");
    expect(source).toContain('aria-labelledby="drive-disconnect-title"');
    expect(source).toContain('aria-describedby="drive-disconnect-body"');
    expect(source).toContain('<h2 id="drive-disconnect-title">Disconnect Google Drive?</h2>');
    expect(source).toMatch(/>\s*Cancel\s*</);
  });

  it("labels the confirm button Disconnect, named Disconnect Google Drive for assistive tech", () => {
    expect(source).toContain('{busy ? "Disconnecting…" : "Disconnect"}');
    expect(source).toContain('aria-label={busy ? undefined : "Disconnect Google Drive"}');
    expect(source).not.toContain('"Disconnecting…" : "Disconnect Google Drive"');
  });
});

describe("passing connect and disconnect messages", () => {
  const notice: Notice = { text: "Google Drive wasn't connected.", problem: true, showGoogleLink: false };

  it("close by themselves after about six seconds", () => {
    vi.useFakeTimers();
    try {
      expect(NOTICE_MS).toBe(6000);
      const board = new NoticeBoard();
      const changes = vi.fn();
      board.subscribe(changes);
      board.show(notice);
      expect(board.get()).toBe(notice);
      vi.advanceTimersByTime(5999);
      expect(board.get()).toBe(notice);
      vi.advanceTimersByTime(1);
      expect(board.get()).toBeNull();
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close at once with the close button, and don't come back", () => {
    vi.useFakeTimers();
    try {
      const board = new NoticeBoard();
      board.show(notice);
      board.dismiss();
      expect(board.get()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restart the timer when a newer message replaces an older one", () => {
    vi.useFakeTimers();
    try {
      const board = new NoticeBoard();
      board.show(notice);
      vi.advanceTimersByTime(4000);
      const newer = connectNotice("popup_blocked")!;
      board.show(newer);
      vi.advanceTimersByTime(4000);
      expect(board.get()).toBe(newer);
      vi.advanceTimersByTime(2000);
      expect(board.get()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is one board for the whole tab", () => {
    expect(getDriveNotices()).toBe(getDriveNotices());
  });
});

describe("Google Drive message area", () => {
  const view = (props: Partial<Parameters<typeof DriveConnectMessageView>[0]>) =>
    renderToStaticMarkup(
      createElement(DriveConnectMessageView, { expired: false, notice: null, onDismiss: () => {}, ...props }),
    );
  const notice = connectNotice("scope_denied")!;

  it("shows a passing message with a labelled close button", () => {
    const html = view({ notice });
    expect(html).toContain('<div class="status-message dismissible problem"><p>Google Drive access wasn&#x27;t allowed, so AuditFlow can&#x27;t use Drive.</p>');
    expect(html).toContain('<button type="button" class="status-message-close" aria-label="Close this Google Drive message"><span aria-hidden="true">×</span></button>');
  });

  it("keeps expired access on screen, with no close button, until it is resolved", () => {
    vi.useFakeTimers();
    try {
      // However long passes, expired access is not a passing notice.
      const board = new NoticeBoard();
      board.show(notice);
      vi.advanceTimersByTime(60_000);
      const html = view({ expired: true, notice: board.get() });
      expect(html).toContain('<div class="status-message problem"><p>Google Drive access expired. Reconnect to keep using Drive.</p></div>');
      expect(html).not.toContain("status-message-close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows expired access and a passing message separately", () => {
    const html = view({ expired: true, notice });
    expect(html.indexOf("access expired")).toBeLessThan(html.indexOf("access wasn&#x27;t allowed"));
    expect(html.match(/status-message-close/g)).toHaveLength(1);
  });

  it("announces through one live region that also describes the header button", () => {
    const html = view({ notice });
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('<p id="drive-connect-status" class="sr-only" role="status" aria-live="polite">');
  });

  it("takes no room when there is nothing to show", () => {
    expect(view({})).toBe(
      '<div class="drive-connect-messages"><p id="drive-connect-status" class="sr-only" role="status" aria-live="polite"></p></div>',
    );
  });

  it("links to the Google Account when Google didn't confirm removal", () => {
    expect(view({ notice: disconnectNotice("unconfirmed")! })).toContain('href="https://myaccount.google.com/connections"');
  });
});

describe("Google Drive message placement", () => {
  // Line endings normalised: a Windows checkout may use CRLF.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  const app = read("../components/audit-flow-app.tsx");
  const button = read("../components/drive-connect-button.tsx");
  const css = read("../app/globals.css");

  it("sits in the page flow right below the header, not under the header button", () => {
    expect(app).toContain("      </header>\n      <DriveConnectMessages />");
    const control = button.slice(button.indexOf("function DriveConnectControl"), button.indexOf("export function DriveConnectMessages"));
    expect(control).not.toContain('id="drive-connect-status"');
    expect(css).not.toContain(".drive-connect-status");
    const area = css.slice(css.indexOf(".drive-connect-messages {"), css.indexOf("}", css.indexOf(".drive-connect-messages {")));
    expect(area).not.toContain("position: absolute");
  });

  it("keeps the header button's labels and its description link", () => {
    expect(button).toContain('disconnected: "Connect"');
    expect(button).toContain('connected: "Disconnect"');
    expect(button).toContain('expired: "Reconnect"');
    expect(button).toContain('aria-describedby="drive-connect-status"');
  });
});

describe("messages and the open Access code panel", () => {
  // Positions measured in the browser at 400px wide: the message area
  // starts at 81px, the open panel spans 106–386px across and ends at 283px.
  const area = { top: 81, left: 18, right: 382 };
  const panel = { bottom: 283, left: 106, right: 386 };

  it("need no room while the panel is closed", () => {
    expect(clearanceBelowPanel(area, null)).toBe(0);
  });

  it("move below an open panel that would cover them, with a small gap", () => {
    expect(clearanceBelowPanel(area, panel)).toBe(283 + 8 - 81);
    expect(clearanceBelowPanel(area, { ...panel, bottom: 283.2 })).toBe(211);
  });

  it("stay put when the panel ends above them or sits beside them", () => {
    expect(clearanceBelowPanel(area, { ...panel, bottom: 70 })).toBe(0);
    expect(clearanceBelowPanel({ top: 81, left: 18, right: 100 }, panel)).toBe(0);
  });

  const view = (props: Partial<Parameters<typeof DriveConnectMessageView>[0]>) =>
    renderToStaticMarkup(
      createElement(DriveConnectMessageView, { expired: false, notice: null, onDismiss: () => {}, ...props }),
    );
  const spacer = '<div class="drive-connect-messages-spacer" aria-hidden="true" style="height:210px"></div>';

  it("keep a passing message, with its close button, below the room made for the panel", () => {
    const html = view({ notice: connectNotice("cancelled")!, clearance: 210 });
    expect(html).toContain(spacer);
    expect(html.indexOf(spacer)).toBeLessThan(html.indexOf("Google Drive wasn&#x27;t connected."));
    expect(html).toContain('aria-label="Close this Google Drive message"');
  });

  it("keep expired access shown below the panel too", () => {
    const html = view({ expired: true, clearance: 210 });
    expect(html).toContain(spacer);
    expect(html).toContain("Google Drive access expired. Reconnect to keep using Drive.");
  });

  it("take no extra room without a message or without an open panel", () => {
    expect(view({ clearance: 210 })).not.toContain("spacer");
    expect(view({ notice: connectNotice("cancelled")!, clearance: 0 })).not.toContain("spacer");
  });

  it("are measured against the panel by the live message area", () => {
    const source = readFileSync(new URL("../components/drive-connect-button.tsx", import.meta.url), "utf-8");
    const area = source.slice(source.indexOf("function DriveConnectMessageArea"), source.indexOf("interface DriveConnectMessageViewProps"));
    expect(area).toContain("useClearOfAccessPanel(expired || notice !== null)");
    expect(area).toContain('document.getElementById("access-code-panel")');
    expect(area).toContain('document.querySelector(".access-code")');
    expect(area).toContain("clearance={clearance}");
  });
});
