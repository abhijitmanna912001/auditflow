import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { connectNotice, DisconnectFlow, disconnectNotice } from "./drive-connect-flow";
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
