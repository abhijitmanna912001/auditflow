import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_SCOPE,
  DriveSession,
  isDriveConfigured,
  readDriveConfig,
  type OAuth2Api,
  type TokenResponse,
} from "./google-drive";

const TOKEN = "test-access-token-not-real";

// A stand-in for google.accounts.oauth2. `respond` plays Google's part once
// requestAccessToken has been called.
function fakeOAuth2(options: { grantScope?: boolean } = {}) {
  let callback: ((response: TokenResponse) => void) | undefined;
  let errorCallback: ((error: { type?: string }) => void) | undefined;
  const api = {
    requestAccessToken: vi.fn(),
    revoke: vi.fn((_token: string, done?: (r: { successful?: boolean; error?: string }) => void) =>
      done?.({ successful: true }),
    ),
    initTokenClient: vi.fn((config: Parameters<OAuth2Api["initTokenClient"]>[0]) => {
      callback = config.callback;
      errorCallback = config.error_callback;
      return { requestAccessToken: api.requestAccessToken };
    }),
    hasGrantedAllScopes: vi.fn(() => options.grantScope ?? true),
  };
  return {
    api,
    respond: (response: TokenResponse) => callback?.(response),
    fail: (type: string) => errorCallback?.({ type }),
  };
}

function sessionWith(oauth2: OAuth2Api) {
  return new DriveSession({ clientId: "client.apps.googleusercontent.com", loadOAuth2: async () => oauth2 });
}

// Lets the awaited loadOAuth2() settle so initTokenClient has been called.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("feature flag", () => {
  it("is on only when all three values are set", () => {
    expect(isDriveConfigured(readDriveConfig({ clientId: "a", apiKey: "b", appId: "1" }))).toBe(true);
    expect(isDriveConfigured(readDriveConfig({ clientId: "a", apiKey: "b" }))).toBe(false);
    expect(isDriveConfigured(readDriveConfig({ clientId: " ", apiKey: "b", appId: "1" }))).toBe(false);
    expect(isDriveConfigured(readDriveConfig({}))).toBe(false);
  });
});

describe("connect", () => {
  it("asks for the drive.file scope only, without forcing consent", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    void session.connect();
    await flush();
    expect(google.api.initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({ scope: DRIVE_SCOPE }),
    );
    expect(google.api.requestAccessToken).toHaveBeenCalledWith({ prompt: "" });
  });

  it("is connected with a token after Google grants the scope", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const result = session.connect();
    expect(session.getState()).toBe("connecting");
    await flush();
    google.respond({ access_token: TOKEN, expires_in: 3599, scope: DRIVE_SCOPE });
    expect(await result).toBe("connected");
    expect(session.getState()).toBe("connected");
    expect(session.getAccessToken()).toBe(TOKEN);
  });

  it("discards and revokes the token when the user unticks Drive access", async () => {
    const google = fakeOAuth2({ grantScope: false });
    const session = sessionWith(google.api);
    const result = session.connect();
    await flush();
    google.respond({ access_token: TOKEN, expires_in: 3599 });
    expect(await result).toBe("scope_denied");
    expect(session.getState()).toBe("disconnected");
    expect(session.getAccessToken()).toBeNull();
    expect(google.api.revoke).toHaveBeenCalledWith(TOKEN, expect.any(Function));
  });

  it.each([
    ["popup_closed", "cancelled"],
    ["popup_failed_to_open", "popup_blocked"],
    ["unknown", "failed"],
  ])("maps a %s popup error to %s and stays disconnected", async (type, outcome) => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const result = session.connect();
    await flush();
    google.fail(type);
    expect(await result).toBe(outcome);
    expect(session.getState()).toBe("disconnected");
  });

  it("treats an error response or a missing token as a failure", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const result = session.connect();
    await flush();
    google.respond({ error: "access_denied" });
    expect(await result).toBe("failed");
    expect(session.getAccessToken()).toBeNull();
  });

  it("fails cleanly when Google's script cannot load", async () => {
    const session = new DriveSession({
      clientId: "client",
      loadOAuth2: () => Promise.reject(new Error("blocked")),
    });
    expect(await session.connect()).toBe("failed");
    expect(session.getState()).toBe("disconnected");
  });

  it("does nothing without a client id", async () => {
    const google = fakeOAuth2();
    const session = new DriveSession({ clientId: "", loadOAuth2: async () => google.api });
    expect(await session.connect()).toBe("not_configured");
    expect(google.api.initTokenClient).not.toHaveBeenCalled();
  });

  it("shares one request between repeated clicks", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const first = session.connect();
    const second = session.connect();
    expect(second).toBe(first);
    await flush();
    expect(google.api.initTokenClient).toHaveBeenCalledTimes(1);
  });
});

describe("expiry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the token a minute before Google's expiry and asks to reconnect", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const result = session.connect();
    await vi.advanceTimersByTimeAsync(0);
    google.respond({ access_token: TOKEN, expires_in: 3600 });
    await result;
    await vi.advanceTimersByTimeAsync(3_540_000 - 1);
    expect(session.getAccessToken()).toBe(TOKEN);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getState()).toBe("expired");
    expect(session.getAccessToken()).toBeNull();
  });
});

describe("token rejected by Google", () => {
  it("drops only the token Google rejected and asks to reconnect", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const result = session.connect();
    await flush();
    google.respond({ access_token: TOKEN, expires_in: 3599 });
    await result;
    session.markTokenRejected("some-older-token");
    expect(session.getAccessToken()).toBe(TOKEN);
    session.markTokenRejected(TOKEN);
    expect(session.getState()).toBe("expired");
    expect(session.getAccessToken()).toBeNull();
  });
});

describe("disconnect", () => {
  async function connected(google = fakeOAuth2()) {
    const session = sessionWith(google.api);
    const result = session.connect();
    await flush();
    google.respond({ access_token: TOKEN, expires_in: 3599 });
    await result;
    return { session, google };
  }

  it("clears the token before revocation runs", async () => {
    const google = fakeOAuth2();
    let tokenDuringRevoke: string | null = "not checked";
    const { session } = await connected(google);
    google.api.revoke.mockImplementation((_token, done) => {
      tokenDuringRevoke = session.getAccessToken();
      done?.({ successful: true });
    });
    expect(await session.disconnect()).toBe("revoked");
    expect(tokenDuringRevoke).toBeNull();
    expect(google.api.revoke).toHaveBeenCalledWith(TOKEN, expect.any(Function));
    expect(session.getState()).toBe("disconnected");
  });

  it.each([
    [{ successful: true }, "revoked"],
    [{ error: "invalid_token" }, "already_invalid"],
    [{ error: "server_error" }, "unconfirmed"],
    [{}, "unconfirmed"],
  ])("reports Google's answer %j as %s", async (response, outcome) => {
    const google = fakeOAuth2();
    google.api.revoke.mockImplementation((_token, done) => done?.(response));
    const { session } = await connected(google);
    expect(await session.disconnect()).toBe(outcome);
  });

  it("is unconfirmed, but still disconnected, when revoke throws", async () => {
    const google = fakeOAuth2();
    google.api.revoke.mockImplementation(() => {
      throw new Error("network");
    });
    const { session } = await connected(google);
    expect(await session.disconnect()).toBe("unconfirmed");
    expect(session.getAccessToken()).toBeNull();
  });

  it("gives up waiting for Google after ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const google = fakeOAuth2();
      google.api.revoke.mockImplementation(() => {});
      const session = sessionWith(google.api);
      const result = session.connect();
      await vi.advanceTimersByTimeAsync(0);
      google.respond({ access_token: TOKEN, expires_in: 3599 });
      await result;
      const outcome = session.disconnect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toBe("unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a token that arrives after the user disconnected", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const result = session.connect();
    await flush();
    await session.disconnect();
    google.respond({ access_token: TOKEN, expires_in: 3599 });
    expect(await result).toBe("cancelled");
    expect(session.getState()).toBe("disconnected");
    expect(session.getAccessToken()).toBeNull();
    expect(google.api.revoke).toHaveBeenCalledWith(TOKEN, expect.any(Function));
  });

  it("can reconnect after disconnecting", async () => {
    const { session, google } = await connected();
    await session.disconnect();
    const again = session.connect();
    await flush();
    google.respond({ access_token: "second-token", expires_in: 3599 });
    expect(await again).toBe("connected");
    expect(session.getAccessToken()).toBe("second-token");
  });

  it("tells disconnect listeners once the token is gone, before revocation", async () => {
    const google = fakeOAuth2();
    const order: string[] = [];
    google.api.revoke.mockImplementation((_token, done) => {
      order.push("revoke");
      done?.({ successful: true });
    });
    const { session } = await connected(google);
    session.onDisconnect(() => order.push(`disconnect:${session.getAccessToken()}`));
    await session.disconnect();
    expect(order).toEqual(["disconnect:null", "revoke"]);
  });

  it("doesn't tell disconnect listeners about expiry, a rejected token or a failed connect", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const onDisconnect = vi.fn();
    session.onDisconnect(onDisconnect);
    const failed = session.connect();
    await flush();
    google.fail("popup_closed");
    await failed;
    const ok = session.connect();
    await flush();
    google.respond({ access_token: TOKEN, expires_in: 3599 });
    await ok;
    session.markTokenRejected(TOKEN);
    expect(session.getState()).toBe("expired");
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("stops telling a listener once it unsubscribes", async () => {
    const { session } = await connected();
    const onDisconnect = vi.fn();
    const stop = session.onDisconnect(onDisconnect);
    stop();
    await session.disconnect();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("notifies listeners on every state change", async () => {
    const google = fakeOAuth2();
    const session = sessionWith(google.api);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getState()));
    const result = session.connect();
    await flush();
    google.respond({ access_token: TOKEN, expires_in: 3599 });
    await result;
    await session.disconnect();
    expect(seen).toEqual(["connecting", "connected", "disconnected"]);
  });
});

describe("token handling in the source", () => {
  // A guard against regressions: the module must never persist or log tokens.
  const source = readFileSync(new URL("./google-drive.ts", import.meta.url), "utf-8");

  it("never uses browser storage, cookies or the console", () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it("never calls the AuditFlow backend", () => {
    expect(source).not.toMatch(/apiFetch|api-client|fetch\(/);
  });
});
