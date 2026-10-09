// Single place for talking to the backend. The optional access code lives in
// sessionStorage only (this browser tab) and is sent in the X-Access-Code
// header to the AuditFlow backend and nowhere else.
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

const STORAGE_KEY = "auditflow-access-code";

export function getAccessCode(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function hasAccessCode(): boolean {
  return getAccessCode() !== "";
}

// Returns false when the browser would not let the code be stored.
export function saveAccessCode(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}

export function clearAccessCode(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing was stored, so nothing to clear.
  }
}

// fetch() against the AuditFlow backend. `path` must start with "/"; the
// header is only ever attached to requests built on API_BASE.
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const code = getAccessCode();
  if (code) headers.set("X-Access-Code", code);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function readDetail(resp: Response): Promise<string | null> {
  try {
    const body = await resp.json();
    return typeof body?.detail === "string" && body.detail.trim() !== ""
      ? body.detail
      : null;
  } catch {
    return null;
  }
}

// Plain-language message for a failed response, or null when the page should
// keep its existing behaviour for that status.
export async function friendlyApiError(resp: Response): Promise<string | null> {
  const withCode = hasAccessCode();
  if (resp.status === 401) {
    return withCode
      ? "That access code isn't valid."
      : "An access code is needed. Enter it at the top of the page.";
  }
  if (resp.status === 429) {
    return withCode
      ? "This access code has reached its limit for today. Please contact us."
      : "The sample cases have reached today's limit. Please try again tomorrow, or contact us.";
  }
  if (resp.status === 403) {
    return "Double-check isn't included with this access code.";
  }
  if (resp.status === 400 || resp.status === 413) {
    return readDetail(resp);
  }
  return null;
}
