// Which files may join an audit run, and how files picked in Google Drive are
// downloaded into the browser as File objects.
//
// Google requests go straight to the Drive API with the Drive token in an
// Authorization header. They never go through the AuditFlow API client, never
// carry the access code, and the token is never put in a URL, stored, logged,
// or attached to the File objects handed to the upload flow.

// Must match the backend's upload limits (orchestration/api.py).
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_RUN = 10;

// The backend picks how to read a file from its extension, so every accepted
// file's name must end with one of these.
const EXTENSIONS = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
} as const;

export type SupportedType = keyof typeof EXTENSIONS;
export const SUPPORTED_TYPES = Object.keys(EXTENSIONS) as SupportedType[];

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";
export const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files/";
const METADATA_FIELDS = "id,name,mimeType,size,trashed,capabilities/canDownload";
const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_NAME_CHARS = 200;
// Drive file ids are URL-safe base64-like strings; anything else is refused
// before it reaches a URL.
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export type SkipReason =
  | "google_native"
  | "folder"
  | "unsupported_type"
  | "too_large"
  | "empty"
  | "over_limit"
  | "duplicate"
  | "not_downloadable"
  | "unavailable"
  | "invalid_content"
  | "expired"
  | "network"
  | "failed";

export interface SkippedFile {
  readonly name: string;
  readonly reason: SkipReason;
}

// What the user picked, before anything is trusted.
export interface PickedFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
}

export function normalizeType(mimeType: string | undefined): string {
  return (mimeType ?? "").split(";")[0].trim().toLowerCase();
}

export function isSupportedType(mimeType: string | undefined): mimeType is SupportedType {
  return Object.hasOwn(EXTENSIONS, normalizeType(mimeType));
}

function typeForName(name: string): SupportedType | null {
  const lower = name.toLowerCase();
  for (const type of SUPPORTED_TYPES) {
    if (EXTENSIONS[type].some((ext) => lower.endsWith(ext))) return type;
  }
  return null;
}

// Why a file of this type and size can't be used, or null when it can.
export function checkTypeAndSize(mimeType: string | undefined, size: number | undefined): SkipReason | null {
  const type = normalizeType(mimeType);
  if (type === GOOGLE_FOLDER) return "folder";
  if (type.startsWith(GOOGLE_NATIVE_PREFIX)) return "google_native";
  if (!isSupportedType(type)) return "unsupported_type";
  if (size !== undefined && Number.isFinite(size)) {
    if (size <= 0) return "empty";
    if (size > MAX_FILE_BYTES) return "too_large";
  }
  return null;
}

// Splits candidates into those that fit and those that don't, keeping the
// run at MAX_FILES_PER_RUN in total. Candidates are kept in order, so the
// first ones chosen are the ones added.
export function fitToCapacity<T extends { readonly name: string }>(
  candidates: readonly T[],
  existingCount: number,
): { fits: T[]; overLimit: SkippedFile[] } {
  const room = Math.max(0, MAX_FILES_PER_RUN - existingCount);
  return {
    fits: candidates.slice(0, room),
    overLimit: candidates.slice(room).map((item) => ({ name: item.name, reason: "over_limit" as const })),
  };
}

// Files chosen with the local file input. The accept attribute is only a
// hint to the browser, so type and size are checked here too.
export function checkLocalFiles(
  files: readonly File[],
  existingCount: number,
): { accepted: File[]; skipped: SkippedFile[] } {
  const skipped: SkippedFile[] = [];
  const usable: File[] = [];
  for (const file of files) {
    const byName = typeForName(file.name);
    const browserType = normalizeType(file.type);
    // An empty browser type is common on some systems; then the extension
    // decides. A type that disagrees with the extension is refused.
    const reason =
      !byName || (browserType !== "" && browserType !== byName)
        ? "unsupported_type"
        : checkTypeAndSize(byName, file.size);
    if (reason) skipped.push({ name: file.name, reason });
    else usable.push(file);
  }
  const { fits, overLimit } = fitToCapacity(usable, existingCount);
  return { accepted: fits, skipped: [...skipped, ...overLimit] };
}

// A name the backend can read: no path separators or control characters,
// a sane length, and an extension that matches the file's type.
export function safeFileName(name: string, type: SupportedType): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  const extensions: readonly string[] = EXTENSIONS[type];
  const ext = extensions.find((e) => clean.toLowerCase().endsWith(e));
  let stem = ext ? clean.slice(0, -ext.length) : clean;
  const suffix = ext ? clean.slice(-ext.length) : extensions[0];
  if (stem.replace(/\./g, "").trim() === "") stem = "drive-file";
  return stem.slice(0, MAX_NAME_CHARS - suffix.length) + suffix;
}

// The type the file's first bytes say it is, or null when they match none
// of the supported types.
export function sniffType(bytes: Uint8Array): SupportedType | null {
  const starts = (sig: readonly number[], offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"; // RIFF....WEBP
  return null;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

class DriveFileError extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

function reasonForStatus(status: number): SkipReason {
  if (status === 401) return "expired";
  // 403: no access, downloading restricted, or a quota; 404: gone or not
  // shared with this app. Either way the user can't fix it by retrying now.
  if (status === 403 || status === 404) return "unavailable";
  return "failed";
}

async function driveRequest(
  fetchImpl: Fetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!resp.ok) throw new DriveFileError(reasonForStatus(resp.status));
    return resp;
  } catch (error) {
    if (error instanceof DriveFileError) throw error;
    throw new DriveFileError("network");
  } finally {
    clearTimeout(timer);
  }
}

interface DriveMetadata {
  name: string;
  type: SupportedType;
}

async function readMetadata(fetchImpl: Fetch, id: string, token: string): Promise<DriveMetadata> {
  const params = new URLSearchParams({ fields: METADATA_FIELDS, supportsAllDrives: "true" });
  const resp = await driveRequest(fetchImpl, `${DRIVE_FILES_URL}${id}?${params}`, token, METADATA_TIMEOUT_MS);
  let data: {
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
    trashed?: unknown;
    capabilities?: { canDownload?: unknown };
  };
  try {
    data = await resp.json();
  } catch {
    throw new DriveFileError("failed");
  }
  if (data.trashed === true) throw new DriveFileError("unavailable");
  const mimeType = typeof data.mimeType === "string" ? data.mimeType : "";
  // Drive sends size as a decimal string; a supported file without one is
  // treated as unknown and checked again after downloading.
  const size = typeof data.size === "string" || typeof data.size === "number" ? Number(data.size) : undefined;
  const reason = checkTypeAndSize(mimeType, size);
  if (reason) throw new DriveFileError(reason);
  if (data.capabilities?.canDownload === false) throw new DriveFileError("not_downloadable");
  return {
    name: typeof data.name === "string" ? data.name : "",
    type: normalizeType(mimeType) as SupportedType,
  };
}

// Reads the body, giving up as soon as it passes the size limit.
async function readCapped(resp: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(resp.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw new DriveFileError("too_large");
  if (!resp.body) {
    const whole = new Uint8Array(await resp.arrayBuffer());
    if (whole.byteLength > MAX_FILE_BYTES) throw new DriveFileError("too_large");
    return whole;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) {
      void reader.cancel().catch(() => {});
      throw new DriveFileError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Checks one picked file with Drive, downloads it, and checks the bytes.
export async function downloadDriveFile(
  picked: PickedFile,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<File> {
  if (!DRIVE_ID.test(picked.id)) throw new DriveFileError("unavailable");
  // The Picker's own answer is checked first, so nothing unsupported is
  // even requested from Drive.
  const early = checkTypeAndSize(picked.mimeType, picked.sizeBytes);
  if (early) throw new DriveFileError(early);
  const meta = await readMetadata(fetchImpl, picked.id, token);
  const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const resp = await driveRequest(fetchImpl, `${DRIVE_FILES_URL}${picked.id}?${params}`, token, DOWNLOAD_TIMEOUT_MS);
    bytes = await readCapped(resp);
  } catch (error) {
    if (error instanceof DriveFileError) throw error;
    throw new DriveFileError("network");
  }
  if (bytes.byteLength === 0) throw new DriveFileError("empty");
  if (sniffType(bytes) !== meta.type) throw new DriveFileError("invalid_content");
  return new File([bytes], safeFileName(meta.name || picked.name, meta.type), { type: meta.type });
}

export function skipReasonOf(error: unknown): SkipReason {
  return error instanceof DriveFileError ? error.reason : "failed";
}

export interface ImportProgress {
  readonly current: number;
  readonly total: number;
  readonly name: string;
}

export interface DriveImportOptions {
  readonly picked: readonly PickedFile[];
  readonly existingCount: number;
  // Drive ids of files already in the list, so picking one again is skipped.
  readonly existingIds?: ReadonlySet<string>;
  // Asked before every request, so an expired or disconnected session
  // stops the import instead of using an old token.
  readonly getToken: () => string | null;
  // Told when Google rejects a token before its expected expiry.
  readonly onTokenRejected?: (token: string) => void;
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly fetchImpl?: Fetch;
}

export interface ImportedFile {
  readonly file: File;
  readonly driveId: string;
}

export interface DriveImportResult {
  readonly accepted: ImportedFile[];
  readonly skipped: SkippedFile[];
  // True when Drive access ended part-way, so the user should reconnect.
  readonly expired: boolean;
}

// Downloads the picked files one at a time. Files that can't be used are
// skipped with a reason; the rest are returned as File objects.
export async function importDriveFiles(options: DriveImportOptions): Promise<DriveImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const skipped: SkippedFile[] = [];
  const candidates: PickedFile[] = [];
  const seen = new Set(options.existingIds ?? []);
  for (const item of options.picked) {
    const name = item.name || "Untitled file";
    const reason = seen.has(item.id) ? "duplicate" : checkTypeAndSize(item.mimeType, item.sizeBytes);
    if (reason) skipped.push({ name, reason });
    else candidates.push({ ...item, name });
    seen.add(item.id);
  }
  const { fits, overLimit } = fitToCapacity(candidates, options.existingCount);
  const accepted: ImportedFile[] = [];
  let expired = false;
  for (const [index, item] of fits.entries()) {
    if (expired) {
      skipped.push({ name: item.name, reason: "expired" });
      continue;
    }
    options.onProgress?.({ current: index + 1, total: fits.length, name: item.name });
    const token = options.getToken();
    if (!token) {
      expired = true;
      skipped.push({ name: item.name, reason: "expired" });
      continue;
    }
    try {
      accepted.push({ file: await downloadDriveFile(item, token, fetchImpl), driveId: item.id });
    } catch (error) {
      const reason = skipReasonOf(error);
      if (reason === "expired") {
        expired = true;
        options.onTokenRejected?.(token);
      }
      skipped.push({ name: item.name, reason });
    }
  }
  return { accepted, skipped: [...skipped, ...overLimit], expired };
}

const reasonText: Record<SkipReason, string> = {
  google_native:
    "is a Google Docs, Sheets or Slides file, which isn't supported yet. In Drive, download it as a PDF, upload that PDF to Drive, then select it.",
  folder: "is a folder. Select individual files instead.",
  unsupported_type: "isn't a PDF, PNG, JPG or WEBP file.",
  too_large: "is larger than 20 MB.",
  empty: "is empty.",
  over_limit: `wasn't added because a check can include at most ${MAX_FILES_PER_RUN} files.`,
  duplicate: "is already in the list.",
  not_downloadable: "can't be downloaded because its owner has turned off downloading.",
  unavailable: "couldn't be opened. It may have been moved or deleted, or you may not have access to it.",
  invalid_content: "doesn't contain a readable PDF, PNG, JPG or WEBP file.",
  expired: "wasn't downloaded because Google Drive access expired. Reconnect Google Drive and select it again.",
  network: "couldn't be downloaded because of a connection problem. Try again.",
  failed: "couldn't be downloaded from Google Drive. Try again.",
};

export function describeSkip(file: SkippedFile): string {
  return `${file.name} ${reasonText[file.reason]}`;
}

export interface SelectionSummary {
  readonly headline: string;
  readonly details: readonly string[];
  readonly problem: boolean;
}

// A short account of what was added and what wasn't, for the page.
export function summarizeSelection(
  source: "drive" | "local",
  acceptedCount: number,
  skipped: readonly SkippedFile[],
  existingCount: number,
): SelectionSummary {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const from = source === "drive" ? " from Google Drive" : "";
  const parts = [acceptedCount > 0 ? `Added ${files(acceptedCount)}${from}.` : `No files were added${from}.`];
  if (skipped.length > 0) parts.push(`Skipped ${files(skipped.length)}:`);
  const details = skipped.map(describeSkip);
  const overLimit = skipped.filter((file) => file.reason === "over_limit").length;
  // Each skipped file already says why; this adds how much room earlier
  // files left, when they took some of it.
  if (overLimit > 0 && existingCount > 0) {
    const room = Math.max(0, MAX_FILES_PER_RUN - existingCount);
    details.push(
      room === 0
        ? `This check already has ${MAX_FILES_PER_RUN} files, the most allowed.`
        : `This check had room for ${room} more file${room === 1 ? "" : "s"} (${MAX_FILES_PER_RUN} at most), so ${files(overLimit)} ${overLimit === 1 ? "wasn't" : "weren't"} added.`,
    );
  }
  return { headline: parts.join(" "), details, problem: skipped.length > 0 };
}

// The page's upload-run counter. Each run takes a new number, and a run's
// results are only shown while it is still the current one.
export interface RunCounter {
  current: number;
}

export function startRun(runs: RunCounter): number {
  runs.current += 1;
  return runs.current;
}

export function isCurrentRun(runs: RunCounter, run: number): boolean {
  return runs.current === run;
}

export interface DisconnectCleanup {
  // The selection without its Drive files; local files keep their order.
  readonly files: File[];
  readonly removed: number;
  // True when the run on the page used Drive files, so its results must go.
  readonly clearResults: boolean;
}

// What a Drive disconnect leaves behind. When the run on the page, finished
// or still running, used Drive files, the run counter moves on too, so a run
// still waiting for the backend can't bring its results back.
export function cleanUpAfterDisconnect(
  files: readonly File[],
  isFromDrive: (file: File) => boolean,
  runUsedDrive: boolean,
  runs: RunCounter,
): DisconnectCleanup {
  const kept = files.filter((file) => !isFromDrive(file));
  if (runUsedDrive) runs.current += 1;
  return { files: kept, removed: files.length - kept.length, clearResults: runUsedDrive };
}
