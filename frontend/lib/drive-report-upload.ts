// Saves an already generated report PDF to the user's Google Drive, in
// My Drive / AuditFlow / <Company> / <YYYY-MM> (see drive-folders.ts).
//
// Saving reuses the bytes generateReportPdf() returned: nothing is
// regenerated, no model is called and nothing goes to the AuditFlow
// backend. The upload goes straight from the browser to Google with the
// in-memory Drive token, under the existing drive.file scope.
//
// Every save creates a new file (files.create); nothing is ever updated or
// overwritten. If the name is taken, "name (2).pdf", "name (3).pdf" and so
// on are used. Success is reported only once Google has answered with the
// new file's id.
//
// Uncertain uploads: a dropped connection, a timeout or a server error can
// hide whether Google created the file. Each save tags its file with a
// random id (kept in memory only) in Drive's appProperties, and after an
// uncertain failure the intended name is looked up in the destination
// folder, with that id, before anything is retried. If the file is there
// the save succeeded; if the lookup can't settle it, the result says so
// instead of claiming success or uploading another copy.

import {
  DriveFolderCache,
  DriveRequestError,
  driveFailureOf,
  driveRequest,
  escapeQueryValue,
  filesOf,
  isDriveId,
  listUrl,
  reportFolderPath,
  type DriveContext,
  type Fetch,
} from "./drive-folders";
import { getDriveSession, type DriveSession } from "./google-drive";

export const PDF_MIME = "application/pdf";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const UPLOAD_TIMEOUT_MS = 60_000;
// Drive's single-request (multipart) upload limit. Reports are far smaller.
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_COPIES = 50;
const MAX_FILE_NAME_CHARS = 200;
// How long to wait before looking for an uncertain upload a second time,
// since a just-created file can take a moment to show up in searches.
const RECHECK_DELAY_MS = 2_000;
const SAVE_ID_PROPERTY = "auditflowSaveId";
const SAVE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** What to save: the generator's bytes and file name, and where it goes. */
export interface DriveReportUpload {
  /** The bytes generateReportPdf() returned. */
  readonly pdf: Uint8Array;
  /** From reportPdfFileName(): AuditFlow_Report_<case-id>_<YYYY-MM-DD>_<HHmmss>.pdf */
  readonly fileName: string;
  /** The app's Company name field as typed. Missing or blank: "No company named". */
  readonly companyName?: string | null;
  /** When the run completed; picks the YYYY-MM folder. */
  readonly completedAt: Date;
}

export type SaveFailure =
  | "busy"
  | "not_connected"
  | "expired"
  | "disconnected"
  | "permission"
  | "rate_limited"
  | "network"
  | "invalid_pdf"
  | "too_large"
  | "invalid_name"
  | "too_many_copies"
  | "failed";

export type UncertainReason = "network" | "disconnected" | "expired" | "invalid_response";

export type DriveSaveResult =
  | {
      readonly status: "saved";
      readonly fileId: string;
      /** The name actually used, which may end in " (2).pdf" and so on. */
      readonly fileName: string;
      readonly folderPath: readonly string[];
      readonly message: string;
    }
  | {
      // The file may or may not be in Drive. Nothing else will be uploaded.
      readonly status: "uncertain";
      readonly reason: UncertainReason;
      readonly fileName: string;
      readonly folderPath: readonly string[];
      readonly message: string;
    }
  | {
      // Nothing was saved.
      readonly status: "failed";
      readonly reason: SaveFailure;
      readonly message: string;
    };

const failureText: Record<SaveFailure, string> = {
  busy: "A report is already being saved to Google Drive. Wait for it to finish.",
  not_connected: "Connect Google Drive to save the report.",
  expired: "Google Drive access expired. Reconnect Google Drive and save again.",
  disconnected: "Google Drive was disconnected, so the report wasn't saved.",
  permission: "Google Drive didn't allow AuditFlow to save the report.",
  rate_limited: "Google Drive is busy. Wait a minute and save again.",
  network: "The report couldn't be saved because of a connection problem. Try again.",
  invalid_pdf: "The report file isn't a valid PDF, so it wasn't saved.",
  too_large: "The report is too large to save to Google Drive.",
  invalid_name: "The report's file name isn't valid, so it wasn't saved.",
  too_many_copies: `There are already ${MAX_COPIES} reports with this name in the folder.`,
  failed: "The report couldn't be saved to Google Drive. Try again.",
};

const uncertainText: Record<UncertainReason, string> = {
  network: "the connection dropped before Google Drive confirmed it",
  disconnected: "Google Drive was disconnected before AuditFlow could confirm it",
  expired: "Google Drive access expired before AuditFlow could confirm it",
  invalid_response: "Google Drive's reply couldn't be read",
};

export const folderPathText = (folderPath: readonly string[]) => ["My Drive", ...folderPath].join(" › ");

/** The minimum of the Drive session the saver uses. */
export type DriveSaveSession = Pick<
  DriveSession,
  "getState" | "getAccessToken" | "markTokenRejected" | "onDisconnect"
>;

export interface DriveReportSaverOptions {
  readonly session: DriveSaveSession;
  readonly fetchImpl?: Fetch;
  /** For tests: how to wait before checking an uncertain upload again. */
  readonly wait?: (ms: number) => Promise<void>;
  /** For tests: the random id that marks this save's file. */
  readonly newSaveId?: () => string;
}

export interface DriveReportSaver {
  /** Saves one report. While a save runs, another call returns "busy". */
  save(upload: DriveReportUpload): Promise<DriveSaveResult>;
  isSaving(): boolean;
}

class SaveError extends Error {
  constructor(readonly reason: SaveFailure) {
    super(reason);
  }
}

class UncertainUpload extends Error {
  constructor(readonly reason: UncertainReason) {
    super(reason);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A safe Drive file name for a report: no control characters, slashes or
 * backslashes, no leading dots, ending in ".pdf", short enough to leave room
 * for a " (50)" suffix. Null when no letter or digit is left.
 */
export function safeReportFileName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.normalize("NFC").replace(CONTROL_CHARACTERS, "_").replace(/[/\\]/g, "_").trim();
  const hasExtension = /\.pdf$/i.test(clean);
  const extension = hasExtension ? clean.slice(-4) : ".pdf";
  const stem = [...(hasExtension ? clean.slice(0, -4) : clean).replace(/^[.\s]+/, "").trim()]
    .slice(0, MAX_FILE_NAME_CHARS - 10)
    .join("")
    .trim();
  return /[\p{L}\p{N}]/u.test(stem) ? stem + extension : null;
}

/** "Report.pdf", copy 2 → "Report (2).pdf". The extension is kept as is. */
export function copyName(fileName: string, copy: number): string {
  if (copy <= 1) return fileName;
  const dot = fileName.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ""];
  return `${stem} (${copy})${extension}`;
}

const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => bytes[index] === byte); // %PDF-

function checkUpload(upload: DriveReportUpload): { pdf: Uint8Array<ArrayBuffer>; fileName: string } {
  const pdf = upload?.pdf;
  if (!(pdf instanceof Uint8Array) || pdf.length === 0 || !isPdf(pdf)) throw new SaveError("invalid_pdf");
  if (pdf.length > MAX_REPORT_BYTES) throw new SaveError("too_large");
  if (!(upload.completedAt instanceof Date) || Number.isNaN(upload.completedAt.getTime())) {
    throw new SaveError("invalid_name");
  }
  const fileName = safeReportFileName(upload.fileName);
  if (!fileName) throw new SaveError("invalid_name");
  // A copy, so the bytes sent can't change while the save runs.
  return { pdf: new Uint8Array(pdf), fileName };
}

interface CreatedFile {
  readonly id: string;
  readonly name: string;
}

/** Exact-name files in the folder, not in the trash. `extra` narrows the query. */
function nameQuery(name: string, folderId: string, extra?: string): string {
  return [
    `name = '${escapeQueryValue(name)}'`,
    `'${escapeQueryValue(folderId)}' in parents`,
    "trashed = false",
    ...(extra ? [extra] : []),
  ].join(" and ");
}

/**
 * The first of name, name (2), name (3)... that no file in the folder has,
 * or this save's own file if a name turns out to be taken by it (an earlier
 * uncertain attempt that did succeed).
 */
async function freeName(
  ctx: DriveContext,
  folderId: string,
  fileName: string,
  saveId: string,
): Promise<{ readonly free: string } | { readonly own: CreatedFile }> {
  for (let copy = 1; copy <= MAX_COPIES; copy++) {
    const candidate = copyName(fileName, copy);
    const body = await driveRequest(ctx, listUrl(nameQuery(candidate, folderId), "files(id,name,appProperties)"), {
      method: "GET",
    });
    const files = filesOf(body);
    const own = files.find((file) => file.appProperties?.[SAVE_ID_PROPERTY] === saveId);
    if (own) return { own: { id: own.id, name: own.name ?? candidate } };
    if (files.length === 0) return { free: candidate };
  }
  throw new SaveError("too_many_copies");
}

/** files.create, multipart: metadata and the PDF bytes in one request. */
async function createFile(
  ctx: DriveContext,
  folderId: string,
  name: string,
  pdf: Uint8Array<ArrayBuffer>,
  saveId: string,
): Promise<CreatedFile> {
  const boundary = `auditflow-${saveId}`;
  const metadata = JSON.stringify({
    name,
    mimeType: PDF_MIME,
    parents: [folderId],
    appProperties: { [SAVE_ID_PROPERTY]: saveId },
  });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${PDF_MIME}\r\n\r\n`,
    pdf,
    `\r\n--${boundary}--\r\n`,
  ]);
  const params = new URLSearchParams({ uploadType: "multipart", fields: "id,name,mimeType,parents" });
  const created = (await driveRequest(
    ctx,
    `${UPLOAD_URL}?${params}`,
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
    UPLOAD_TIMEOUT_MS,
  )) as { id?: unknown; name?: unknown; mimeType?: unknown; parents?: unknown } | null;
  const wrongType = created?.mimeType !== undefined && created.mimeType !== PDF_MIME;
  const wrongFolder = Array.isArray(created?.parents) && !created.parents.includes(folderId);
  if (!isDriveId(created?.id) || wrongType || wrongFolder) throw new DriveRequestError("invalid_response");
  return { id: created.id, name: typeof created.name === "string" && created.name ? created.name : name };
}

export function createDriveReportSaver(options: DriveReportSaverOptions): DriveReportSaver {
  const { session } = options;
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newSaveId = options.newSaveId ?? (() => crypto.randomUUID());
  const folders = new DriveFolderCache();
  // Another Google account may connect next, so its folders must be found afresh.
  session.onDisconnect(() => folders.clear());
  let active: Promise<DriveSaveResult> | null = null;

  /** This save's file, looked up by its intended name and save id. */
  async function findOwnUpload(
    ctx: DriveContext,
    folderId: string,
    name: string,
    saveId: string,
  ): Promise<CreatedFile | null> {
    const query = nameQuery(
      name,
      folderId,
      `appProperties has { key='${SAVE_ID_PROPERTY}' and value='${escapeQueryValue(saveId)}' }`,
    );
    for (let check = 1; check <= 2; check++) {
      if (check === 2) await wait(RECHECK_DELAY_MS);
      let files;
      try {
        files = filesOf(await driveRequest(ctx, listUrl(query, "files(id,name)"), { method: "GET" }));
      } catch (error) {
        const reason = driveFailureOf(error);
        if (reason === "disconnected") throw error;
        throw new UncertainUpload(reason === "no_token" || reason === "expired" ? "expired" : "network");
      }
      if (files.length > 0) return { id: files[0].id, name: files[0].name ?? name };
    }
    return null;
  }

  async function upload(
    ctx: DriveContext,
    folderPath: readonly string[],
    pdf: Uint8Array<ArrayBuffer>,
    fileName: string,
    markSent: (name: string) => void,
  ): Promise<CreatedFile> {
    let folderId = await folders.ensurePath(folderPath, ctx);
    const saveId = newSaveId();
    if (!SAVE_ID.test(saveId)) throw new SaveError("failed");
    // True once an attempt may have created the file: from then on no
    // failure can be reported as "nothing was saved".
    let maybeCreated = false;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const choice = await freeName(ctx, folderId, fileName, saveId);
        if ("own" in choice) return choice.own;
        const name = choice.free;
        markSent(name);
        try {
          return await createFile(ctx, folderId, name, pdf, saveId);
        } catch (error) {
          if (!(error instanceof DriveRequestError) || error.reason === "disconnected") throw error;
          if (!error.uncertain && error.reason !== "invalid_response") {
            // Google refused it, so nothing was created. If the folder has
            // gone since it was found, find or create it again, once.
            if (error.reason === "not_found" && attempt === 1) {
              folders.forgetPath(folderPath);
              folderId = await folders.ensurePath(folderPath, ctx);
              continue;
            }
            throw error;
          }
          // Google may have created the file. Look before doing anything else.
          maybeCreated = true;
          const found = await findOwnUpload(ctx, folderId, name, saveId);
          if (found) return found;
          // Google answered but the answer was unreadable: don't upload again.
          if (error.reason === "invalid_response") throw new UncertainUpload("invalid_response");
          // Not found twice: it was most likely never created, so try once
          // more (same save id, so a later check still finds either copy).
        }
      }
      throw new UncertainUpload("network");
    } catch (error) {
      if (!maybeCreated || error instanceof UncertainUpload) throw error;
      const reason = driveFailureOf(error);
      if (reason === "disconnected") throw error;
      throw new UncertainUpload(reason === "no_token" || reason === "expired" ? "expired" : "network");
    }
  }

  async function run(request: DriveReportUpload): Promise<DriveSaveResult> {
    let pdf: Uint8Array<ArrayBuffer>;
    let fileName: string;
    try {
      ({ pdf, fileName } = checkUpload(request));
    } catch (error) {
      const reason = error instanceof SaveError ? error.reason : "failed";
      return { status: "failed", reason, message: failureText[reason] };
    }
    const state = session.getState();
    if (state !== "connected" || !session.getAccessToken()) {
      const reason = state === "expired" ? "expired" : "not_connected";
      return { status: "failed", reason, message: failureText[reason] };
    }

    const folderPath = reportFolderPath(request.companyName, request.completedAt);
    const disconnect = new AbortController();
    const stopWatching = session.onDisconnect(() => disconnect.abort());
    const ctx: DriveContext = {
      getToken: () => session.getAccessToken(),
      onTokenRejected: (token) => session.markTokenRejected(token),
      fetchImpl,
      signal: disconnect.signal,
    };
    // The names of create requests sent so far: from the first one on, the
    // file may exist even if the save fails.
    const sentNames: string[] = [];
    const uncertain = (reason: UncertainReason): DriveSaveResult => {
      const names = sentNames.length > 0 ? sentNames : [fileName];
      return {
        status: "uncertain",
        reason,
        fileName: names[0],
        folderPath,
        message:
          `AuditFlow can't tell whether the report was saved: ${uncertainText[reason]}. ` +
          `Look for ${names.map((name) => `“${name}”`).join(" or ")} in ${folderPathText(folderPath)} before saving again.`,
      };
    };
    try {
      const file = await upload(ctx, folderPath, pdf, fileName, (name) => {
        if (!sentNames.includes(name)) sentNames.push(name);
      });
      // Never report success once the user has disconnected.
      if (disconnect.signal.aborted) return uncertain("disconnected");
      return {
        status: "saved",
        fileId: file.id,
        fileName: file.name,
        folderPath,
        message: `Saved to Google Drive as “${file.name}” in ${folderPathText(folderPath)}.`,
      };
    } catch (error) {
      if (disconnect.signal.aborted || driveFailureOf(error) === "disconnected") {
        if (sentNames.length > 0) return uncertain("disconnected");
        return { status: "failed", reason: "disconnected", message: failureText.disconnected };
      }
      if (error instanceof UncertainUpload) return uncertain(error.reason);
      const reason = failureFor(error);
      return { status: "failed", reason, message: failureText[reason] };
    } finally {
      stopWatching();
    }
  }

  return {
    save(request) {
      if (active) return Promise.resolve({ status: "failed", reason: "busy", message: failureText.busy });
      const current = run(request).finally(() => {
        active = null;
      });
      active = current;
      return current;
    },
    isSaving: () => active !== null,
  };
}

/** A failure before any upload could have reached Google: nothing was saved. */
function failureFor(error: unknown): SaveFailure {
  if (error instanceof SaveError) return error.reason;
  switch (driveFailureOf(error)) {
    case "no_token":
    case "expired":
      return "expired";
    case "permission":
      return "permission";
    case "rate_limited":
      return "rate_limited";
    case "network":
    case "timeout":
    case "server":
      return "network";
    default:
      return "failed";
  }
}

let pageSaver: DriveReportSaver | null = null;

/** The one saver for this page, so only one save runs at a time. */
export function getDriveReportSaver(): DriveReportSaver {
  pageSaver ??= createDriveReportSaver({ session: getDriveSession() });
  return pageSaver;
}
