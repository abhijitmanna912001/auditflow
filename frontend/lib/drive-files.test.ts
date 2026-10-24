import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The upload flow's backend client, mocked so the tests can see exactly what
// would be sent to AuditFlow and prove Google requests never go through it.
vi.mock("./api-client", () => ({
  apiFetch: vi.fn(async () =>
    new Response(JSON.stringify({ case_id: "UPLOADED_1", rows: [], summary: {} }), { status: 200 }),
  ),
  friendlyApiError: vi.fn(async () => null),
}));

import { apiFetch } from "./api-client";
import {
  checkLocalFiles,
  checkTypeAndSize,
  cleanUpAfterDisconnect,
  downloadDriveFile,
  fitToCapacity,
  importDriveFiles,
  isCurrentRun,
  startRun,
  MAX_FILE_BYTES,
  MAX_FILES_PER_RUN,
  safeFileName,
  skipReasonOf,
  sniffType,
  summarizeSelection,
  type PickedFile,
} from "./drive-files";
import { fetchWorkpaperFromUpload } from "./mock-workpaper";

const TOKEN = "test-drive-token-not-real";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

interface FakeFile {
  // Metadata Drive returns, or an HTTP status to fail with.
  readonly meta: Record<string, unknown> | number;
  // Content Drive returns, an HTTP status, or a network failure.
  readonly content?: Uint8Array<ArrayBuffer> | number | "network";
  readonly headers?: Record<string, string>;
}

// A stand-in for the Drive API, recording every request.
function fakeDrive(files: Record<string, FakeFile>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const parsed = new URL(url);
    const id = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
    const file = files[id];
    if (!file) return new Response("{}", { status: 404 });
    if (parsed.searchParams.get("alt") !== "media") {
      return typeof file.meta === "number"
        ? new Response("{\"error\":{\"message\":\"secret google detail\"}}", { status: file.meta })
        : new Response(JSON.stringify(file.meta), { status: 200 });
    }
    if (file.content === "network") throw new TypeError("Failed to fetch");
    if (typeof file.content === "number") return new Response("nope", { status: file.content });
    return new Response(file.content ?? PDF, { status: 200, headers: file.headers });
  });
}

function pdfMeta(name: string, size = PDF.byteLength) {
  return { id: name, name, mimeType: "application/pdf", size: String(size), capabilities: { canDownload: true } };
}

function picked(id: string, mimeType = "application/pdf", sizeBytes?: number): PickedFile {
  return { id, name: `${id}.pdf`, mimeType, sizeBytes };
}

beforeEach(() => {
  vi.mocked(apiFetch).mockClear();
});

describe("supported types", () => {
  it.each(["application/pdf", "image/png", "image/jpeg", "image/webp", "IMAGE/PNG", "image/jpeg; q=1"])(
    "accepts %s",
    (type) => {
      expect(checkTypeAndSize(type, 1000)).toBeNull();
    },
  );

  it.each(["text/plain", "image/gif", "image/svg+xml", "application/zip", "application/octet-stream", ""])(
    "rejects %s",
    (type) => {
      expect(checkTypeAndSize(type, 1000)).toBe("unsupported_type");
    },
  );

  it.each([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
  ])("rejects the Google-native %s with its own reason", (type) => {
    expect(checkTypeAndSize(type, undefined)).toBe("google_native");
  });

  it("rejects folders", () => {
    expect(checkTypeAndSize("application/vnd.google-apps.folder", undefined)).toBe("folder");
  });

  it("recognises file contents by their first bytes", () => {
    expect(sniffType(PDF)).toBe("application/pdf");
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(JPEG)).toBe("image/jpeg");
    expect(sniffType(WEBP)).toBe("image/webp");
    expect(sniffType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffType(new Uint8Array())).toBeNull();
  });
});

describe("20 MB per-file limit", () => {
  it("allows exactly 20 MB and refuses a byte more", () => {
    expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    expect(checkTypeAndSize("application/pdf", MAX_FILE_BYTES)).toBeNull();
    expect(checkTypeAndSize("application/pdf", MAX_FILE_BYTES + 1)).toBe("too_large");
  });

  it("refuses empty files", () => {
    expect(checkTypeAndSize("application/pdf", 0)).toBe("empty");
  });
});

describe("local files", () => {
  it("checks type and size in code, not just through the accept attribute", () => {
    const files = [
      new File([PDF], "invoice.pdf", { type: "application/pdf" }),
      new File([PNG], "receipt.PNG", { type: "" }),
      new File(["x"], "notes.txt", { type: "text/plain" }),
      new File([PNG], "fake.pdf", { type: "image/png" }),
      new File([new Uint8Array(MAX_FILE_BYTES + 1)], "huge.pdf", { type: "application/pdf" }),
      new File([], "blank.webp", { type: "image/webp" }),
    ];
    const { accepted, skipped } = checkLocalFiles(files, 0);
    expect(accepted.map((f) => f.name)).toEqual(["invoice.pdf", "receipt.PNG"]);
    expect(skipped).toEqual([
      { name: "notes.txt", reason: "unsupported_type" },
      { name: "fake.pdf", reason: "unsupported_type" },
      { name: "huge.pdf", reason: "too_large" },
      { name: "blank.webp", reason: "empty" },
    ]);
  });
});

describe("10-file limit", () => {
  it("keeps the first files that fit and marks the rest", () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}` }));
    const { fits, overLimit } = fitToCapacity(items, MAX_FILES_PER_RUN - 2);
    expect(fits.map((i) => i.name)).toEqual(["f0", "f1"]);
    expect(overLimit).toEqual([
      { name: "f2", reason: "over_limit" },
      { name: "f3", reason: "over_limit" },
    ]);
  });

  it("caps local files at 10 including files already selected from Drive", () => {
    const files = Array.from({ length: 5 }, (_, i) => new File([PDF], `local${i}.pdf`, { type: "application/pdf" }));
    const { accepted, skipped } = checkLocalFiles(files, 7);
    expect(accepted).toHaveLength(3);
    expect(skipped.map((s) => s.reason)).toEqual(["over_limit", "over_limit"]);
  });

  it("downloads only the Drive files that fit beside the local files already chosen", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const fetchImpl = fakeDrive(Object.fromEntries(ids.map((id) => [id, { meta: pdfMeta(id) }])));
    const result = await importDriveFiles({
      picked: ids.map((id) => picked(id)),
      existingCount: 7,
      getToken: () => TOKEN,
      fetchImpl,
    });
    expect(result.accepted.map((f) => f.driveId)).toEqual(["a", "b", "c"]);
    expect(result.skipped).toEqual([
      { name: "d.pdf", reason: "over_limit" },
      { name: "e.pdf", reason: "over_limit" },
    ]);
    const requested = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname.split("/").pop());
    expect(new Set(requested)).toEqual(new Set(["a", "b", "c"]));
  });

  it("explains how much room was left", () => {
    const summary = summarizeSelection(
      "drive",
      3,
      [
        { name: "d.pdf", reason: "over_limit" },
        { name: "e.pdf", reason: "over_limit" },
      ],
      7,
    );
    expect(summary.headline).toBe("Added 3 files from Google Drive. Skipped 2 files:");
    expect(summary.details.at(-1)).toBe("This check had room for 3 more files (10 at most), so 2 files weren't added.");
    expect(summary.problem).toBe(true);
  });
});

describe("Google-native files", () => {
  it("skips Docs and Sheets without requesting them from Drive", async () => {
    const fetchImpl = fakeDrive({});
    const result = await importDriveFiles({
      picked: [
        { id: "doc1", name: "Budget notes", mimeType: "application/vnd.google-apps.document" },
        { id: "sheet1", name: "Ledger", mimeType: "application/vnd.google-apps.spreadsheet" },
      ],
      existingCount: 0,
      getToken: () => TOKEN,
      fetchImpl,
    });
    expect(result.accepted).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["google_native", "google_native"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    const summary = summarizeSelection("drive", 0, result.skipped, 0);
    expect(summary.headline).toBe("No files were added from Google Drive. Skipped 2 files:");
    expect(summary.details[0]).toMatch(/^Budget notes is a Google Docs, Sheets or Slides file, which isn't supported yet/);
  });

  it("trusts Drive's metadata over the Picker's answer", async () => {
    const fetchImpl = fakeDrive({
      doc1: { meta: { name: "Notes", mimeType: "application/vnd.google-apps.document" } },
    });
    await expect(downloadDriveFile(picked("doc1"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "google_native",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("downloading", () => {
  it("builds a File with the downloaded bytes, the Drive type and a usable name", async () => {
    const fetchImpl = fakeDrive({
      img1: {
        meta: { name: "scan from phone", mimeType: "image/png", size: String(PNG.byteLength) },
        content: PNG,
      },
    });
    const file = await downloadDriveFile(
      { id: "img1", name: "scan from phone", mimeType: "image/png", sizeBytes: PNG.byteLength },
      TOKEN,
      fetchImpl,
    );
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("scan from phone.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(PNG.byteLength);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it("sends only the Drive token, in a header, straight to Google", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a") } });
    await downloadDriveFile(picked("a"), TOKEN, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url.startsWith("https://www.googleapis.com/drive/v3/files/a?")).toBe(true);
      expect(url).not.toContain(TOKEN);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.has("X-Access-Code")).toBe(false);
      expect([...headers.keys()]).toEqual(["authorization"]);
      expect(init?.credentials).toBe("omit");
      expect(init?.cache).toBe("no-store");
    }
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("alt")).toBe("media");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses a file Drive says is over 20 MB without downloading it", async () => {
    const fetchImpl = fakeDrive({ big: { meta: pdfMeta("big", MAX_FILE_BYTES + 1) } });
    await expect(downloadDriveFile(picked("big"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "too_large",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rechecks the size of what actually arrives", async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(PDF);
    const fetchImpl = fakeDrive({ a: { meta: { name: "a.pdf", mimeType: "application/pdf" }, content: big } });
    await expect(downloadDriveFile(picked("a"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "too_large",
    );
  });

  it("rechecks the type of what actually arrives", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a"), content: PNG } });
    await expect(downloadDriveFile(picked("a"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "invalid_content",
    );
  });

  it("respects files whose owner turned off downloading", async () => {
    const fetchImpl = fakeDrive({ a: { meta: { ...pdfMeta("a"), capabilities: { canDownload: false } } } });
    await expect(downloadDriveFile(picked("a"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "not_downloadable",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats trashed files as unavailable", async () => {
    const fetchImpl = fakeDrive({ a: { meta: { ...pdfMeta("a"), trashed: true } } });
    await expect(downloadDriveFile(picked("a"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "unavailable",
    );
  });

  it("never puts an unexpected id into a URL", async () => {
    const fetchImpl = fakeDrive({});
    await expect(downloadDriveFile(picked("../../about"), TOKEN, fetchImpl)).rejects.toSatisfy(
      (error) => skipReasonOf(error) === "unavailable",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cleans names so the backend can read them", () => {
    expect(safeFileName("folder/inv\\01.pdf", "application/pdf")).toBe("folder_inv_01.pdf");
    expect(safeFileName("photo.JPEG", "image/jpeg")).toBe("photo.JPEG");
    expect(safeFileName("photo", "image/jpeg")).toBe("photo.jpg");
    expect(safeFileName("", "image/webp")).toBe("drive-file.webp");
    expect(safeFileName("..", "application/pdf")).toBe("drive-file.pdf");
    const long = safeFileName(`${"x".repeat(300)}.pdf`, "application/pdf");
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("failed or inaccessible files", () => {
  it.each([
    [{ meta: 404 }, "unavailable"],
    [{ meta: 403 }, "unavailable"],
    [{ meta: 500 }, "failed"],
    [{ meta: pdfMeta("a"), content: 404 }, "unavailable"],
    [{ meta: pdfMeta("a"), content: 503 }, "failed"],
    [{ meta: pdfMeta("a"), content: "network" }, "network"],
  ] as const)("maps %j to %s", async (file, reason) => {
    const fetchImpl = fakeDrive({ a: file });
    const result = await importDriveFiles({ picked: [picked("a")], existingCount: 0, getToken: () => TOKEN, fetchImpl });
    expect(result.skipped).toEqual([{ name: "a.pdf", reason }]);
  });

  it("keeps the files that worked when others fail", async () => {
    const fetchImpl = fakeDrive({ ok: { meta: pdfMeta("ok") }, gone: { meta: 404 } });
    const result = await importDriveFiles({
      picked: [picked("ok"), picked("gone")],
      existingCount: 0,
      getToken: () => TOKEN,
      fetchImpl,
    });
    expect(result.accepted.map((f) => f.file.name)).toEqual(["ok.pdf"]);
    expect(result.skipped).toEqual([{ name: "gone.pdf", reason: "unavailable" }]);
    expect(result.expired).toBe(false);
  });

  it("never shows Google's own error text", () => {
    const summary = summarizeSelection("drive", 0, [{ name: "a.pdf", reason: "failed" }], 0);
    expect(summary.details.join(" ")).not.toContain("secret google detail");
  });

  it("skips a file that is already in the list", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a") } });
    const result = await importDriveFiles({
      picked: [picked("a"), picked("a")],
      existingCount: 0,
      existingIds: new Set(["a"]),
      getToken: () => TOKEN,
      fetchImpl,
    });
    expect(result.skipped.map((s) => s.reason)).toEqual(["duplicate", "duplicate"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("missing or expired tokens", () => {
  it("downloads nothing without a token", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a") }, b: { meta: pdfMeta("b") } });
    const result = await importDriveFiles({
      picked: [picked("a"), picked("b")],
      existingCount: 0,
      getToken: () => null,
      fetchImpl,
    });
    expect(result.expired).toBe(true);
    expect(result.skipped.map((s) => s.reason)).toEqual(["expired", "expired"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops after Google rejects the token and reports it", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a") }, b: { meta: 401 }, c: { meta: pdfMeta("c") } });
    const onTokenRejected = vi.fn();
    const result = await importDriveFiles({
      picked: [picked("a"), picked("b"), picked("c")],
      existingCount: 0,
      getToken: () => TOKEN,
      onTokenRejected,
      fetchImpl,
    });
    expect(result.accepted.map((f) => f.driveId)).toEqual(["a"]);
    expect(result.skipped).toEqual([
      { name: "b.pdf", reason: "expired" },
      { name: "c.pdf", reason: "expired" },
    ]);
    expect(result.expired).toBe(true);
    expect(onTokenRejected).toHaveBeenCalledWith(TOKEN);
    const requested = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname.split("/").pop());
    expect(requested).not.toContain("c");
  });

  it("asks for the token again before every file", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a") }, b: { meta: pdfMeta("b") } });
    const getToken = vi.fn().mockReturnValueOnce(TOKEN).mockReturnValueOnce(null);
    const result = await importDriveFiles({ picked: [picked("a"), picked("b")], existingCount: 0, getToken, fetchImpl });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(result.accepted).toHaveLength(1);
    expect(result.skipped).toEqual([{ name: "b.pdf", reason: "expired" }]);
  });

  it("reports progress for each download", async () => {
    const fetchImpl = fakeDrive({ a: { meta: pdfMeta("a") }, b: { meta: pdfMeta("b") } });
    const onProgress = vi.fn();
    await importDriveFiles({ picked: [picked("a"), picked("b")], existingCount: 0, getToken: () => TOKEN, onProgress, fetchImpl });
    expect(onProgress.mock.calls).toEqual([
      [{ current: 1, total: 2, name: "a.pdf" }],
      [{ current: 2, total: 2, name: "b.pdf" }],
    ]);
  });
});

describe("handing Drive files to the existing upload flow", () => {
  it("sends only the file contents to AuditFlow, never the token or Drive ids", async () => {
    const fetchImpl = fakeDrive({ "drive-id-123": { meta: pdfMeta("invoice") } });
    const result = await importDriveFiles({
      picked: [picked("drive-id-123")],
      existingCount: 0,
      getToken: () => TOKEN,
      fetchImpl,
    });
    const local = new File([PNG], "receipt.png", { type: "image/png" });
    await fetchWorkpaperFromUpload([local, ...result.accepted.map((f) => f.file)], false);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(path).toMatch(/^\/run-case-upload\?case_id=UPLOADED_\d+$/);
    expect(path).not.toContain(TOKEN);
    expect(path).not.toContain("drive-id-123");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    const form = init?.body as FormData;
    const entries = [...form.entries()];
    expect(entries.map(([key]) => key)).toEqual(["files", "files"]);
    expect(entries.map(([, value]) => (value as File).name)).toEqual(["receipt.png", "invoice.pdf"]);
    for (const [, value] of entries) {
      const text = new TextDecoder().decode(await (value as File).arrayBuffer());
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("disconnect cleanup", () => {
  const local1 = new File([PDF], "local1.pdf", { type: "application/pdf" });
  const local2 = new File([PNG], "local2.png", { type: "image/png" });
  const drive1 = new File([PDF], "drive1.pdf", { type: "application/pdf" });
  const drive2 = new File([PDF], "drive2.pdf", { type: "application/pdf" });
  const fromDrive = new WeakSet([drive1, drive2]);
  const isFromDrive = (file: File) => fromDrive.has(file);

  it("removes Drive files and keeps local files in order", () => {
    const runs = { current: 3 };
    const cleanup = cleanUpAfterDisconnect([local1, drive1, local2, drive2], isFromDrive, false, runs);
    expect(cleanup.files).toEqual([local1, local2]);
    expect(cleanup.files[0]).toBe(local1);
    expect(cleanup.removed).toBe(2);
    expect(cleanup.clearResults).toBe(false);
    expect(runs.current).toBe(3);
  });

  it("clears results from a run that used Drive files", () => {
    const runs = { current: 3 };
    const cleanup = cleanUpAfterDisconnect([local1, drive1], isFromDrive, true, runs);
    expect(cleanup.files).toEqual([local1]);
    expect(cleanup.clearResults).toBe(true);
  });

  it("clears results from a Drive run even after its files were replaced", () => {
    // The run used Drive files, but the user has since chosen a sample case.
    const cleanup = cleanUpAfterDisconnect([], isFromDrive, true, { current: 1 });
    expect(cleanup).toEqual({ files: [], removed: 0, clearResults: true });
  });

  it("changes nothing for a selection and run without Drive files", () => {
    const runs = { current: 5 };
    const cleanup = cleanUpAfterDisconnect([local1, local2], isFromDrive, false, runs);
    expect(cleanup).toEqual({ files: [local1, local2], removed: 0, clearResults: false });
    expect(runs.current).toBe(5);
  });
});

describe("stale run results", () => {
  // Mirrors the page: start a run, wait for the backend, then show results
  // only if the run is still current.
  function pageRun(runs: { current: number }) {
    let respond: (rows: string[]) => void = () => {};
    const shown: string[][] = [];
    const run = startRun(runs);
    const done = new Promise<string[]>((resolve) => (respond = resolve)).then((rows) => {
      if (isCurrentRun(runs, run)) shown.push(rows);
    });
    return { respond, done, shown };
  }

  it("drops the results of a Drive run that returns after a disconnect", async () => {
    const runs = { current: 0 };
    const inFlight = pageRun(runs);
    cleanUpAfterDisconnect([], () => true, true, runs);
    inFlight.respond(["INV-1 amount mismatch"]);
    await inFlight.done;
    expect(inFlight.shown).toEqual([]);
  });

  it("keeps the results of a local-only run that returns after a disconnect", async () => {
    const runs = { current: 0 };
    const inFlight = pageRun(runs);
    cleanUpAfterDisconnect([], () => false, false, runs);
    inFlight.respond(["INV-2 clean"]);
    await inFlight.done;
    expect(inFlight.shown).toEqual([["INV-2 clean"]]);
  });

  it("lets only the newest run show results", async () => {
    const runs = { current: 0 };
    const first = pageRun(runs);
    const second = pageRun(runs);
    second.respond(["second"]);
    first.respond(["first"]);
    await Promise.all([first.done, second.done]);
    expect(first.shown).toEqual([]);
    expect(second.shown).toEqual([["second"]]);
  });
});

describe("token handling in the source", () => {
  const sources = ["./drive-files.ts", "./google-picker.ts", "../components/drive-file-picker.tsx"].map((path) => [
    path,
    readFileSync(new URL(path, import.meta.url), "utf-8"),
  ]);

  it.each(sources)("%s never uses browser storage, cookies or the console", (_path, source) => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it.each(sources)("%s never uses the AuditFlow API client", (_path, source) => {
    expect(source).not.toMatch(/apiFetch|api-client|X-Access-Code|API_BASE/);
  });
});
