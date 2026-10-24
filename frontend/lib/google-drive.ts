// Google Drive connection for this browser tab. Connecting Drive is separate
// from the AuditFlow access code: it only authorises this tab to use the
// user's Drive with the drive.file scope.
//
// The access token lives in this module's memory only. It is never written to
// storage, logged, put in a URL, or sent to the AuditFlow backend, and it is
// cleared before Google is asked to revoke it.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
// Treat the token as expired a minute early so a call never starts with a
// token that runs out mid-request.
const EXPIRY_MARGIN_MS = 60_000;
const REVOKE_TIMEOUT_MS = 10_000;

export interface DriveConfig {
  readonly clientId: string;
  readonly apiKey: string;
  readonly appId: string;
}

// Each NEXT_PUBLIC_ variable is referenced in full so Next.js inlines it.
const configuredDrive: DriveConfig = readDriveConfig({
  clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
  apiKey: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
  appId: process.env.NEXT_PUBLIC_GOOGLE_APP_ID,
});

export function readDriveConfig(values: {
  clientId?: string;
  apiKey?: string;
  appId?: string;
}): DriveConfig {
  return {
    clientId: values.clientId?.trim() ?? "",
    apiKey: values.apiKey?.trim() ?? "",
    appId: values.appId?.trim() ?? "",
  };
}

// The feature flag: Drive stays hidden unless all three values are set.
export function isDriveConfigured(config: DriveConfig = configuredDrive): boolean {
  return config.clientId !== "" && config.apiKey !== "" && config.appId !== "";
}

// The parts of Google Identity Services' token model used here.
export interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

export interface OAuth2Api {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string }) => void;
  }): TokenClient;
  hasGrantedAllScopes?(response: TokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: (response: { successful?: boolean; error?: string }) => void): void;
}

export type DriveState = "disconnected" | "connecting" | "connected" | "expired";

export type ConnectOutcome =
  | "connected"
  | "scope_denied"
  | "cancelled"
  | "popup_blocked"
  | "failed"
  | "not_configured";

export type DisconnectOutcome = "revoked" | "already_invalid" | "unconfirmed";

export interface DriveSessionOptions {
  readonly clientId: string;
  readonly loadOAuth2: () => Promise<OAuth2Api>;
}

export class DriveSession {
  private state: DriveState = "disconnected";
  private token: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<ConnectOutcome> | null = null;
  // Bumped on disconnect, so a token Google returns afterwards is discarded.
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: DriveSessionOptions) {}

  getState(): DriveState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // The current token, or null when not connected or expired. Callers must
  // not keep it: ask again for every request.
  getAccessToken(): string | null {
    return this.state === "connected" ? this.token : null;
  }

  // Must be called from a click handler so Google's popup is not blocked.
  connect(): Promise<ConnectOutcome> {
    if (this.pending) return this.pending;
    if (!this.options.clientId) return Promise.resolve("not_configured");
    this.setState("connecting");
    this.pending = this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  // Clears the token first, so nothing can use it while revocation runs.
  async disconnect(): Promise<DisconnectOutcome> {
    const token = this.token;
    this.generation += 1;
    this.clearToken();
    this.setState("disconnected");
    if (!token) return "unconfirmed";
    let oauth2: OAuth2Api;
    try {
      oauth2 = await this.options.loadOAuth2();
    } catch {
      return "unconfirmed";
    }
    return revokeToken(oauth2, token);
  }

  private async requestToken(): Promise<ConnectOutcome> {
    const generation = this.generation;
    let oauth2: OAuth2Api;
    try {
      oauth2 = await this.options.loadOAuth2();
    } catch {
      this.setState("disconnected");
      return "failed";
    }
    return new Promise<ConnectOutcome>((resolve) => {
      const finish = (outcome: ConnectOutcome) => {
        if (outcome !== "connected" && generation === this.generation) {
          this.setState("disconnected");
        }
        resolve(outcome);
      };
      try {
        const client = oauth2.initTokenClient({
          client_id: this.options.clientId,
          scope: DRIVE_SCOPE,
          callback: (response) => {
            if (response.error || !response.access_token) {
              finish("failed");
              return;
            }
            if (generation !== this.generation) {
              void revokeToken(oauth2, response.access_token);
              finish("cancelled");
              return;
            }
            // Google lets the user untick Drive on the consent screen.
            if (!grantedDriveScope(oauth2, response)) {
              void revokeToken(oauth2, response.access_token);
              finish("scope_denied");
              return;
            }
            this.storeToken(response.access_token, response.expires_in);
            finish("connected");
          },
          error_callback: (error) => {
            if (error?.type === "popup_closed") finish("cancelled");
            else if (error?.type === "popup_failed_to_open") finish("popup_blocked");
            else finish("failed");
          },
        });
        // An empty prompt only shows consent when Google needs it.
        client.requestAccessToken({ prompt: "" });
      } catch {
        finish("failed");
      }
    });
  }

  private storeToken(token: string, expiresIn: number | string | undefined): void {
    this.clearToken();
    this.token = token;
    const seconds = Number(expiresIn);
    const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
    const delay = Math.max(0, lifetimeMs - EXPIRY_MARGIN_MS);
    this.expiryTimer = setTimeout(() => this.expire(), delay);
    this.setState("connected");
  }

  private expire(): void {
    this.clearToken();
    this.setState("expired");
  }

  private clearToken(): void {
    this.token = null;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private setState(state: DriveState): void {
    if (this.state === state) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

function grantedDriveScope(oauth2: OAuth2Api, response: TokenResponse): boolean {
  if (typeof oauth2.hasGrantedAllScopes === "function") {
    return oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE);
  }
  return (response.scope ?? "").split(" ").includes(DRIVE_SCOPE);
}

function revokeToken(oauth2: OAuth2Api, token: string): Promise<DisconnectOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unconfirmed"), REVOKE_TIMEOUT_MS);
    const done = (outcome: DisconnectOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      oauth2.revoke(token, (response) => {
        if (response?.successful === true) done("revoked");
        else if (response?.error === "invalid_token") done("already_invalid");
        else done("unconfirmed");
      });
    } catch {
      done("unconfirmed");
    }
  });
}

let gisPromise: Promise<OAuth2Api> | null = null;

// Loads Google Identity Services once per page. A failed load can be retried.
export function loadGoogleOAuth2(): Promise<OAuth2Api> {
  gisPromise ??= new Promise<OAuth2Api>((resolve, reject) => {
    const loaded = () =>
      (window as unknown as { google?: { accounts?: { oauth2?: OAuth2Api } } })
        .google?.accounts?.oauth2;
    const ready = () => {
      const oauth2 = loaded();
      if (oauth2) resolve(oauth2);
      else reject(new Error("Google sign-in did not load"));
    };
    if (loaded()) {
      ready();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SCRIPT_URL}"]`,
    );
    if (existing?.dataset.loaded === "yes") {
      ready();
      return;
    }
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => {
      script.dataset.loaded = "yes";
      ready();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Google sign-in did not load")), {
      once: true,
    });
    if (!existing) {
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    gisPromise = null;
    throw error;
  });
  return gisPromise;
}

let session: DriveSession | null = null;

// The one Drive session for this tab.
export function getDriveSession(): DriveSession {
  session ??= new DriveSession({
    clientId: configuredDrive.clientId,
    loadOAuth2: loadGoogleOAuth2,
  });
  return session;
}
