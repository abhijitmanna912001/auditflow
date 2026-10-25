// Finds or creates the folders a saved report goes into:
//
//   My Drive / AuditFlow / <Company> / <YYYY-MM> / <report>.pdf
//
// Requests go straight from the browser to the Drive API with the Drive
// token in an Authorization header, as in drive-files.ts. They never go
// through the AuditFlow API client and never carry the access code. The
// token is asked for before every request and is never stored, logged or
// put in a URL. Folder IDs are kept in this module's memory for the page
// session only.
//
// Access limitation: the drive.file scope only lets AuditFlow see files and
// folders it created itself (or that the user opened with it). A folder the
// user made by hand called "AuditFlow" is invisible to these queries, so
// AuditFlow creates its own folder with the same name next to it. That is
// accepted: the scope is not broadened and Drive is never scanned.

import { GOOGLE_FOLDER } from "./drive-files";
import { NO_COMPANY_NAME } from "./report-pdf-document";

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const ROOT_FOLDER_NAME = "AuditFlow";
export const MAX_FOLDER_NAME_CHARS = 100;
const REQUEST_TIMEOUT_MS = 20_000;
// Drive file ids are URL-safe base64-like strings; anything else is refused
// before it reaches a URL or a query. "root" is Drive's alias for My Drive.
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// Why a Drive request failed. `uncertain` failures happened after the
// request may have reached Google, so it may have taken effect.
export type DriveFailure =
  | "no_token"
  | "expired"
  | "disconnected"
  | "permission"
  | "rate_limited"
  | "not_found"
  | "network"
  | "timeout"
  | "server"
  | "invalid_response"
  | "failed";

export class DriveRequestError extends Error {
  constructor(readonly reason: DriveFailure) {
    super(reason);
    this.name = "DriveRequestError";
  }

  // The request may have reached Google: a dropped connection, a timeout or
  // a server error. 4xx answers mean nothing was changed.
  get uncertain(): boolean {
    return this.reason === "network" || this.reason === "timeout" || this.reason === "server";
  }
}

export const driveFailureOf = (error: unknown): DriveFailure =>
  error instanceof DriveRequestError ? error.reason : "failed";

// What every request needs. The token is asked for each time, so an expired
// or disconnected session stops the work instead of using an old token.
export interface DriveContext {
  readonly getToken: () => string | null;
  // Told when Google rejects a token before its expected expiry.
  readonly onTokenRejected?: (token: string) => void;
  readonly fetchImpl: Fetch;
  // Aborted when the user disconnects Drive.
  readonly signal?: AbortSignal;
}

async function failureForStatus(resp: Response): Promise<DriveFailure> {
  if (resp.status === 401) return "expired";
  if (resp.status === 404) return "not_found";
  if (resp.status === 429) return "rate_limited";
  if (resp.status >= 500) return "server";
  if (resp.status === 403) {
    // Drive reports rate limits as 403 with a reason; only that is read.
    try {
      const body = (await resp.json()) as { error?: { errors?: { reason?: unknown }[] } };
      const reason = body.error?.errors?.[0]?.reason;
      if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return "rate_limited";
    } catch {
      // No readable body: treat it as a permission problem.
    }
    return "permission";
  }
  return "failed";
}

/** One Drive API request; returns the parsed JSON body. */
export async function driveRequest(
  ctx: DriveContext,
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: BodyInit },
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (ctx.signal?.aborted) throw new DriveRequestError("disconnected");
  const token = ctx.getToken();
  if (!token) throw new DriveRequestError("no_token");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onDisconnect = () => controller.abort();
  ctx.signal?.addEventListener("abort", onDisconnect);
  let resp: Response;
  try {
    resp = await ctx.fetchImpl(url, {
      method: init.method,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      body: init.body,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } catch {
    if (ctx.signal?.aborted) throw new DriveRequestError("disconnected");
    throw new DriveRequestError(timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onDisconnect);
  }
  if (!resp.ok) {
    const failure = await failureForStatus(resp);
    if (failure === "expired") ctx.onTokenRejected?.(token);
    throw new DriveRequestError(failure);
  }
  try {
    return await resp.json();
  } catch {
    throw new DriveRequestError("invalid_response");
  }
}

/**
 * Escapes a value for a single-quoted string in a Drive query: backslashes
 * first, then single quotes. URL encoding happens separately, when the
 * query is put into the request's parameters.
 */
export const escapeQueryValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function isDriveId(value: unknown): value is string {
  return typeof value === "string" && DRIVE_ID.test(value);
}

/** Non-trashed folders with exactly this name, directly inside the parent. */
export function folderQuery(name: string, parentId: string): string {
  return [
    `name = '${escapeQueryValue(name)}'`,
    `mimeType = '${GOOGLE_FOLDER}'`,
    `'${escapeQueryValue(parentId)}' in parents`,
    "trashed = false",
  ].join(" and ");
}

export function listUrl(query: string, fields: string): string {
  const params = new URLSearchParams({
    q: query,
    fields,
    spaces: "drive",
    // Oldest first, so if two folders share a name (made by two tabs at
    // once), every save picks the same one.
    orderBy: "createdTime",
    pageSize: "10",
  });
  return `${DRIVE_FILES_URL}?${params}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Cuts to at most `max` characters without splitting a surrogate pair. */
const cut = (text: string, max: number) => [...text].slice(0, max).join("");

/**
 * The Company folder's name: the app's Company name field as typed, made
 * safe for a Drive folder. Slashes and backslashes become hyphens, control
 * characters become spaces, leading dots and outer spaces are removed and
 * the name is cut to MAX_FOLDER_NAME_CHARS. Unicode letters are kept. A
 * missing or blank name, or one with nothing left, is NO_COMPANY_NAME.
 */
export function companyFolderName(company: string | null | undefined): string {
  const name = cut(
    (typeof company === "string" ? company : "")
      .normalize("NFC")
      .replace(CONTROL_CHARACTERS, " ")
      .replace(/[/\\]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[.\s]+/, ""),
    MAX_FOLDER_NAME_CHARS,
  ).trim();
  return name || NO_COMPANY_NAME;
}

/** "2026-10": the month the run completed, in local time like the file name. */
export function monthFolderName(completedAt: Date): string {
  return `${completedAt.getFullYear()}-${String(completedAt.getMonth() + 1).padStart(2, "0")}`;
}

export function reportFolderPath(company: string | null | undefined, completedAt: Date): string[] {
  return [ROOT_FOLDER_NAME, companyFolderName(company), monthFolderName(completedAt)];
}

interface DriveFileEntry {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly trashed?: boolean;
  readonly appProperties?: Readonly<Record<string, string>>;
}

/** The `files` array of a files.list answer, keeping only entries with valid ids. */
export function filesOf(body: unknown): DriveFileEntry[] {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new DriveRequestError("invalid_response");
  return files.filter((file): file is DriveFileEntry => isDriveId((file as DriveFileEntry | null)?.id));
}

const pathKey = (segments: readonly string[]) => JSON.stringify(segments);

/**
 * Folder IDs for the page session. Each folder path is resolved by one
 * shared promise at a time, so concurrent saves to the same place never
 * create the same folder twice.
 */
export class DriveFolderCache {
  private readonly ids = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();

  /** Forgets every folder, for example after Drive is disconnected. */
  clear(): void {
    this.ids.clear();
    this.inFlight.clear();
  }

  /** The id of the last folder in the path, creating any that are missing. */
  ensurePath(segments: readonly string[], ctx: DriveContext): Promise<string> {
    if (segments.length === 0 || segments.some((name) => name.trim() === "")) {
      return Promise.reject(new DriveRequestError("failed"));
    }
    const key = pathKey(segments);
    const running = this.inFlight.get(key);
    if (running) return running;
    const promise = this.resolve(segments, ctx).finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async resolve(segments: readonly string[], ctx: DriveContext): Promise<string> {
    const key = pathKey(segments);
    const cached = this.ids.get(key);
    if (cached && (await isUsableFolder(cached, ctx))) return cached;
    // Gone, trashed or no longer accessible: forget it and everything
    // under it, and look again from its parent.
    if (cached) this.forgetPath(segments);

    const parentId = segments.length === 1 ? "root" : await this.ensurePath(segments.slice(0, -1), ctx);
    const name = segments[segments.length - 1];
    const id = (await findFolder(name, parentId, ctx)) ?? (await createFolder(name, parentId, ctx));
    this.ids.set(key, id);
    return id;
  }

  /** Forgets a folder and every folder under it. */
  forgetPath(segments: readonly string[]): void {
    const prefix = pathKey(segments).slice(0, -1);
    for (const key of [...this.ids.keys()]) {
      if (key.startsWith(prefix)) this.ids.delete(key);
    }
  }
}

/** Whether a remembered folder still exists, is a folder and is not in the trash. */
async function isUsableFolder(id: string, ctx: DriveContext): Promise<boolean> {
  const params = new URLSearchParams({ fields: "id,mimeType,trashed" });
  try {
    const body = (await driveRequest(ctx, `${DRIVE_FILES_URL}/${id}?${params}`, { method: "GET" })) as DriveFileEntry;
    return body?.id === id && body.mimeType === GOOGLE_FOLDER && body.trashed !== true;
  } catch (error) {
    // 404: deleted, or not visible to this app any more. 403 on a folder we
    // made usually means the same. Anything else is a real failure.
    const reason = driveFailureOf(error);
    if (reason === "not_found" || reason === "permission") return false;
    throw error;
  }
}

async function findFolder(name: string, parentId: string, ctx: DriveContext): Promise<string | null> {
  const body = await driveRequest(ctx, listUrl(folderQuery(name, parentId), "files(id,name,mimeType,trashed)"), {
    method: "GET",
  });
  const match = filesOf(body).find(
    (file) => file.name === name && file.mimeType === GOOGLE_FOLDER && file.trashed !== true,
  );
  return match?.id ?? null;
}

async function createFolder(name: string, parentId: string, ctx: DriveContext): Promise<string> {
  const params = new URLSearchParams({ fields: "id,name,mimeType,trashed" });
  try {
    const body = (await driveRequest(ctx, `${DRIVE_FILES_URL}?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: GOOGLE_FOLDER, parents: [parentId] }),
    })) as DriveFileEntry | null;
    if (!isDriveId(body?.id) || body.mimeType !== GOOGLE_FOLDER) {
      throw new DriveRequestError("invalid_response");
    }
    return body.id;
  } catch (error) {
    // The folder may have been created before the connection dropped. Look
    // once more instead of creating a second one.
    if (error instanceof DriveRequestError && (error.uncertain || error.reason === "invalid_response")) {
      const found = await findFolder(name, parentId, ctx);
      if (found) return found;
    }
    throw error;
  }
}
