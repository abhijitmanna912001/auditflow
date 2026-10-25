import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The AuditFlow backend client, mocked so the tests can prove saving never
// goes through it.
vi.mock("./api-client", () => ({
  apiFetch: vi.fn(async () => new Response("{}", { status: 200 })),
  friendlyApiError: vi.fn(async () => null),
}));

import type { Workpaper } from "../types/workpaper";
import { apiFetch } from "./api-client";
import { driveRequest } from "./drive-folders";
import {
  copyName,
  createDriveReportSaver,
  MAX_COPIES,
  MAX_REPORT_BYTES,
  PDF_MIME,
  safeReportFileName,
  type DriveReportUpload,
  type DriveSaveResult,
} from "./drive-report-upload";
import { generateReportPdf, reportPdfFileName } from "./report-pdf";
import { FakeDrive, fakeSession, FOLDER_MIME, TINY_PDF, TOKEN, type RecordedRequest } from "./testing/fake-drive";

const COMPLETED_AT = new Date(2026, 9, 25, 9, 5, 7);
const FILE_NAME = reportPdfFileName("CASE_14", COMPLETED_AT); // AuditFlow_Report_Case-14_2026-10-25_090507.pdf
const COMPANY = "Kaveri Traders";
const PATH = ["AuditFlow", COMPANY, "2026-10"];

function setup() {
  const drive = new FakeDrive();
  const session = fakeSession(drive);
  const waits: number[] = [];
  let saves = 0;
  const saver = createDriveReportSaver({
    session,
    fetchImpl: drive.fetch,
    wait: async (ms) => {
      waits.push(ms);
    },
    newSaveId: () => `test-save-id-${++saves}`,
  });
  return { drive, session, saver, waits };
}

const upload = (extra: Partial<DriveReportUpload> = {}): DriveReportUpload => ({
  pdf: TINY_PDF,
  fileName: FILE_NAME,
  companyName: COMPANY,
  completedAt: COMPLETED_AT,
  ...extra,
});

const isUpload = (r: RecordedRequest) => r.url.pathname === "/upload/drive/v3/files";
const uploads = (drive: FakeDrive) => drive.requests.filter(isUpload);
const ownChecks = (drive: FakeDrive) =>
  drive.requests.filter((r) => (r.url.searchParams.get("q") ?? "").includes("appProperties has"));
const pdfsIn = (drive: FakeDrive, folderId: string) => drive.children(folderId).filter((f) => f.mimeType === PDF_MIME);

function expectSaved(result: DriveSaveResult): asserts result is Extract<DriveSaveResult, { status: "saved" }> {
  expect(result.status).toBe("saved");
}

describe("saving a report", () => {
  it("creates the PDF in My Drive / AuditFlow / Company / YYYY-MM with the generator's file name", async () => {
    const { drive, saver } = setup();
    const result = await saver.save(upload());
    expectSaved(result);

    const month = drive.folderAt(...PATH)!;
    const [file] = pdfsIn(drive, month.id);
    expect(result).toMatchObject({ fileId: file.id, fileName: FILE_NAME, folderPath: PATH });
    expect(file.name).toBe("AuditFlow_Report_Case-14_2026-10-25_090507.pdf");
    expect(result.message).toBe(
      "Saved to Google Drive as “AuditFlow_Report_Case-14_2026-10-25_090507.pdf” in My Drive › AuditFlow › Kaveri Traders › 2026-10.",
    );
  });

  it("sends the exact bytes as application/pdf with one create request", async () => {
    const { drive, saver } = setup();
    await saver.save(upload());
    const [request] = uploads(drive);
    expect(request.method).toBe("POST");
    expect(request.url.origin + request.url.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files");
    expect(request.url.searchParams.get("uploadType")).toBe("multipart");
    expect(request.headers.get("Content-Type")).toMatch(/^multipart\/related; boundary=/);

    const month = drive.folderAt(...PATH)!;
    const [file] = pdfsIn(drive, month.id);
    expect(file).toMatchObject({ name: FILE_NAME, mimeType: PDF_MIME, parents: [month.id] });
    expect(Buffer.from(file.bytes!).equals(Buffer.from(TINY_PDF))).toBe(true);
  });

  it("uses No company named when the Company name field is empty", async () => {
    const { drive, saver } = setup();
    for (const companyName of [undefined, null, "", "   "]) {
      expectSaved(await saver.save(upload({ companyName })));
    }
    const folder = drive.folderAt("AuditFlow", "No company named", "2026-10")!;
    expect(pdfsIn(drive, folder.id)).toHaveLength(4);
  });

  it("saves bytes straight from generateReportPdf() unchanged", async () => {
    const workpaper: Workpaper = JSON.parse(
      readFileSync(new URL("./fixtures/case-14-workpaper.json", import.meta.url), "utf8"),
    );
    const pdf = await generateReportPdf({ workpaper, completedAt: COMPLETED_AT, companyName: COMPANY });
    const { drive, saver } = setup();
    expectSaved(await saver.save(upload({ pdf, fileName: reportPdfFileName(workpaper.case_id, COMPLETED_AT) })));
    const [file] = pdfsIn(drive, drive.folderAt(...PATH)!.id);
    expect(Buffer.from(file.bytes!).equals(Buffer.from(pdf))).toBe(true);
  });
});

describe("file names and no overwriting", () => {
  it("adds (2), (3)... when the name is taken, and never touches existing files", async () => {
    const { drive, saver } = setup();
    expectSaved(await saver.save(upload()));
    const month = drive.folderAt(...PATH)!;
    const original = { ...pdfsIn(drive, month.id)[0] };

    const second = await saver.save(upload());
    const third = await saver.save(upload());
    expect(second).toMatchObject({ status: "saved", fileName: "AuditFlow_Report_Case-14_2026-10-25_090507 (2).pdf" });
    expect(third).toMatchObject({ status: "saved", fileName: "AuditFlow_Report_Case-14_2026-10-25_090507 (3).pdf" });

    expect(pdfsIn(drive, month.id)).toHaveLength(3);
    expect(drive.items.get(original.id)).toEqual(original);
    // Only create requests: no update, replace or delete of any file.
    for (const request of drive.requests) {
      expect(["GET", "POST"]).toContain(request.method);
      if (request.method === "POST") expect(request.url.pathname).toMatch(/^\/(upload\/)?drive\/v3\/files$/);
    }
  });

  it("checks each candidate name with an exact, escaped, non-trashed query in the folder", async () => {
    const { drive, saver } = setup();
    expectSaved(await saver.save(upload({ fileName: "Rao's report.pdf" })));
    const month = drive.folderAt(...PATH)!;
    expect(drive.requests.map((r) => r.url.searchParams.get("q"))).toContain(
      `name = 'Rao\\'s report.pdf' and '${month.id}' in parents and trashed = false`,
    );
    expect(pdfsIn(drive, month.id)[0].name).toBe("Rao's report.pdf");
  });

  it("does not count a trashed file or a file in another folder as taken", async () => {
    const { drive, saver } = setup();
    expectSaved(await saver.save(upload()));
    const month = drive.folderAt(...PATH)!;
    pdfsIn(drive, month.id)[0].trashed = true;
    drive.addFile(FILE_NAME, "root");
    expect(await saver.save(upload())).toMatchObject({ status: "saved", fileName: FILE_NAME });
  });

  it(`gives up after ${MAX_COPIES} copies with the same name`, async () => {
    const { drive, saver } = setup();
    expectSaved(await saver.save(upload()));
    const month = drive.folderAt(...PATH)!;
    for (let copy = 2; copy <= MAX_COPIES; copy++) drive.addFile(copyName(FILE_NAME, copy), month.id);
    const before = uploads(drive).length;
    expect(await saver.save(upload())).toMatchObject({ status: "failed", reason: "too_many_copies" });
    expect(uploads(drive)).toHaveLength(before);
  });

  it.each([
    ["Report.pdf", 2, "Report (2).pdf"],
    ["Report.PDF", 3, "Report (3).PDF"],
    ["Report", 2, "Report (2)"],
    ["Report.pdf", 1, "Report.pdf"],
  ])("names copy %s #%i as %s", (name, copy, expected) => {
    expect(copyName(name, copy)).toBe(expected);
  });

  it.each([
    [FILE_NAME, FILE_NAME],
    ["../evil/name.pdf", "_evil_name.pdf"],
    ["a\\b\u0000c\u001f.pdf", "a_b_c_.pdf"],
    ["...hidden.pdf", "hidden.pdf"],
    ["Société Müller ₹.pdf", "Société Müller ₹.pdf"],
    ["no extension", "no extension.pdf"],
  ])("makes %j a safe file name", (input, expected) => {
    expect(safeReportFileName(input)).toBe(expected);
  });

  it("cuts long names but keeps .pdf and room for a copy number", () => {
    const name = safeReportFileName(`${"x".repeat(400)}.pdf`)!;
    expect(name.endsWith(".pdf")).toBe(true);
    expect(copyName(name, MAX_COPIES).length).toBeLessThanOrEqual(200);
  });

  it.each(["", "   ", ".pdf", "...", "/", "_\\_.pdf", null, 42])("rejects the file name %j", async (fileName) => {
    const { drive, saver } = setup();
    expect(await saver.save(upload({ fileName: fileName as string }))).toMatchObject({
      status: "failed",
      reason: "invalid_name",
    });
    expect(drive.requests).toHaveLength(0);
  });
});

describe("PDF checks", () => {
  it.each([
    ["empty bytes", new Uint8Array(0), "invalid_pdf"],
    ["not a PDF", new TextEncoder().encode("<html>not a pdf</html>"), "invalid_pdf"],
    ["a string", "%PDF-1.3" as unknown as Uint8Array, "invalid_pdf"],
    ["too large", (() => {
      const big = new Uint8Array(MAX_REPORT_BYTES + 1);
      big.set(TINY_PDF);
      return big;
    })(), "too_large"],
  ] as const)("refuses %s without contacting Drive", async (_, pdf, reason) => {
    const { drive, saver } = setup();
    expect(await saver.save(upload({ pdf }))).toMatchObject({ status: "failed", reason });
    expect(drive.requests).toHaveLength(0);
  });
});

describe("Google's answer", () => {
  it("reports success only with a file id from Google", async () => {
    const { drive, saver } = setup();
    // Google answers 200 without creating anything, and the reply has no id.
    drive.failNext(isUpload, { body: "{}", handled: false });
    const result = await saver.save(upload());
    expect(result).toMatchObject({ status: "uncertain", reason: "invalid_response" });
    // It looked for the file, didn't find it, and did not upload again.
    expect(ownChecks(drive)).toHaveLength(2);
    expect(uploads(drive)).toHaveLength(1);
  });

  it.each([
    ["no id", "{}"],
    ["an invalid id", JSON.stringify({ id: "../../etc" })],
    ["the wrong type", JSON.stringify({ id: "abc123", mimeType: "text/html" })],
    ["the wrong folder", JSON.stringify({ id: "abc123", mimeType: PDF_MIME, parents: ["other"] })],
    ["unreadable JSON", "not json"],
  ])("confirms by lookup when the answer has %s", async (_, body) => {
    const { drive, saver } = setup();
    // Google creates the file but the answer can't be trusted.
    drive.failNext(isUpload, { body });
    const result = await saver.save(upload());
    expectSaved(result);
    const [file] = pdfsIn(drive, drive.folderAt(...PATH)!.id);
    expect(result.fileId).toBe(file.id);
    expect(uploads(drive)).toHaveLength(1);
  });

  it("reports a refused upload as failed, without retrying", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, 403);
    expect(await saver.save(upload())).toMatchObject({ status: "failed", reason: "permission" });
    expect(uploads(drive)).toHaveLength(1);
    expect(ownChecks(drive)).toHaveLength(0);
  });

  it("finds the folder again if it vanished just before the upload", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, 404);
    expectSaved(await saver.save(upload()));
    expect(uploads(drive)).toHaveLength(2);
    expect(pdfsIn(drive, drive.folderAt(...PATH)!.id)).toHaveLength(1);
  });
});

describe("uncertain uploads", () => {
  it("checks by name before retrying when the request failed before reaching Google", async () => {
    const { drive, saver, waits } = setup();
    drive.failNext(isUpload, "network");
    expectSaved(await saver.save(upload()));
    expect(uploads(drive)).toHaveLength(2);
    const checks = ownChecks(drive);
    expect(checks).toHaveLength(2);
    expect(drive.requests.indexOf(checks[1])).toBeLessThan(drive.requests.indexOf(uploads(drive)[1]));
    expect(waits).toEqual([2000]);
    const month = drive.folderAt(...PATH)!;
    expect(checks[0].url.searchParams.get("q")).toBe(
      `name = '${FILE_NAME}' and '${month.id}' in parents and trashed = false and ` +
        "appProperties has { key='auditflowSaveId' and value='test-save-id-1' }",
    );
    expect(pdfsIn(drive, month.id)).toHaveLength(1);
  });

  it("does not upload again when Google created the file but the answer was lost", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "lost");
    const result = await saver.save(upload());
    expectSaved(result);
    expect(result.fileName).toBe(FILE_NAME);
    expect(uploads(drive)).toHaveLength(1);
    expect(pdfsIn(drive, drive.folderAt(...PATH)!.id)).toHaveLength(1);
  });

  it("treats a server error as uncertain too", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, 503);
    expectSaved(await saver.save(upload()));
    expect(ownChecks(drive)).toHaveLength(2);
    expect(pdfsIn(drive, drive.folderAt(...PATH)!.id)).toHaveLength(1);
  });

  it("recognises its own file under the name when the search was slow to show it", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "lost");
    // Both checks miss the new file, as if Drive's search hadn't caught up.
    drive.failNext((r) => (r.url.searchParams.get("q") ?? "").includes("appProperties"), { body: '{"files":[]}', handled: false });
    drive.failNext((r) => (r.url.searchParams.get("q") ?? "").includes("appProperties"), { body: '{"files":[]}', handled: false });
    const result = await saver.save(upload());
    expectSaved(result);
    expect(result.fileName).toBe(FILE_NAME);
    expect(uploads(drive)).toHaveLength(1);
    expect(pdfsIn(drive, drive.folderAt(...PATH)!.id)).toHaveLength(1);
  });

  it("reports uncertainty after two uncertain attempts, and never tries a third", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "network");
    drive.failNext(isUpload, "network");
    const result = await saver.save(upload());
    expect(result).toMatchObject({ status: "uncertain", reason: "network", fileName: FILE_NAME });
    expect(result.status === "uncertain" && result.message).toContain(FILE_NAME);
    expect(uploads(drive)).toHaveLength(2);
    expect(ownChecks(drive)).toHaveLength(4);
  });

  it("reports uncertainty without retrying when the check itself fails", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "lost");
    drive.failNext((r) => (r.url.searchParams.get("q") ?? "").includes("appProperties"), "network");
    expect(await saver.save(upload())).toMatchObject({ status: "uncertain", reason: "network" });
    expect(uploads(drive)).toHaveLength(1);
  });

  it("reports uncertainty when the retry is refused after an uncertain first attempt", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "network");
    drive.failNext(isUpload, 403);
    expect(await saver.save(upload())).toMatchObject({ status: "uncertain" });
  });

  it("checks instead of re-uploading when Google created the file but its reply body never arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { drive, saver } = setup();
      drive.failNext(isUpload, "stall");
      const pending = saver.save(upload());
      // Past the 60-second upload timeout; the stalled body can't hold it.
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await pending;
      expectSaved(result);
      expect(uploads(drive)).toHaveLength(1);
      expect(ownChecks(drive)).toHaveLength(1);
      expect(pdfsIn(drive, drive.folderAt(...PATH)!.id)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports success when Drive is disconnected while the upload's reply body is read", async () => {
    const { drive, saver, session } = setup();
    drive.failNext(isUpload, "stall");
    const pending = saver.save(upload());
    await vi.waitFor(() => expect(uploads(drive)).toHaveLength(1));
    session.disconnect();
    expect(await pending).toMatchObject({ status: "uncertain", reason: "disconnected" });
  });

  it("maps a timeout to an uncertain failure", async () => {
    const drive = new FakeDrive();
    drive.failNext(() => true, "hang");
    const error = await driveRequest(
      { getToken: () => TOKEN, fetchImpl: drive.fetch },
      "https://www.googleapis.com/drive/v3/files",
      { method: "GET" },
      20,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "timeout", uncertain: true });
  });
});

describe("one save at a time", () => {
  it("answers busy to a second save while one runs, so uploads never overlap", async () => {
    const { drive, saver } = setup();
    const first = saver.save(upload());
    expect(saver.isSaving()).toBe(true);
    const second = await saver.save(upload());
    expect(second).toMatchObject({ status: "failed", reason: "busy" });
    expectSaved(await first);
    expect(saver.isSaving()).toBe(false);
    expect(uploads(drive)).toHaveLength(1);
    expect(drive.children("root", FOLDER_MIME)).toHaveLength(1);
    // Free again afterwards.
    expectSaved(await saver.save(upload()));
  });

  it("is free again after a failed save", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, 403);
    expect((await saver.save(upload())).status).toBe("failed");
    expectSaved(await saver.save(upload()));
  });
});

describe("token and connection", () => {
  it("does nothing when Drive isn't connected", async () => {
    const { drive, saver, session } = setup();
    session.disconnect();
    expect(await saver.save(upload())).toMatchObject({ status: "failed", reason: "not_connected" });
    expect(drive.requests).toHaveLength(0);
  });

  it("does nothing when the token has expired", async () => {
    const { drive, saver, session } = setup();
    session.expire();
    expect(await saver.save(upload())).toMatchObject({
      status: "failed",
      reason: "expired",
      message: "Google Drive access expired. Reconnect Google Drive and save again.",
    });
    expect(drive.requests).toHaveLength(0);
  });

  it("stops when Google rejects the token, and marks it rejected", async () => {
    const { drive, saver, session } = setup();
    drive.validToken = "revoked-elsewhere";
    const realToken = session.getAccessToken;
    session.getAccessToken = () => TOKEN;
    const result = await saver.save(upload());
    session.getAccessToken = realToken;
    expect(result).toMatchObject({ status: "failed", reason: "expired" });
    expect(session.markTokenRejected).toHaveBeenCalledWith(TOKEN);
    expect(uploads(drive)).toHaveLength(0);
  });

  it("reports a rejected token on the upload itself as failed (nothing was created)", async () => {
    const { drive, saver, session } = setup();
    drive.failNext(isUpload, 401);
    expect(await saver.save(upload())).toMatchObject({ status: "failed", reason: "expired" });
    expect(session.markTokenRejected).toHaveBeenCalledWith(TOKEN);
  });

  it("fails cleanly on a connection problem before the upload", async () => {
    const { drive, saver } = setup();
    drive.failNext(() => true, "network");
    expect(await saver.save(upload())).toMatchObject({ status: "failed", reason: "network" });
    expect(uploads(drive)).toHaveLength(0);
  });

  it("reports a permission error clearly", async () => {
    const { drive, saver } = setup();
    drive.failNext(() => true, 403);
    expect(await saver.save(upload())).toMatchObject({
      status: "failed",
      reason: "permission",
      message: "Google Drive didn't allow AuditFlow to save the report.",
    });
  });

  it("fails without uploading when Drive is disconnected before the upload", async () => {
    const { drive, saver, session } = setup();
    drive.failNext(() => true, "hang");
    const pending = saver.save(upload());
    await vi.waitFor(() => expect(drive.requests).toHaveLength(1));
    session.disconnect();
    expect(await pending).toMatchObject({ status: "failed", reason: "disconnected" });
    expect(uploads(drive)).toHaveLength(0);
  });

  it("never reports success when Drive is disconnected during the upload", async () => {
    const { drive, saver, session } = setup();
    drive.failNext(isUpload, "hang");
    const pending = saver.save(upload());
    await vi.waitFor(() => expect(uploads(drive)).toHaveLength(1));
    session.disconnect();
    const result = await pending;
    expect(result).toMatchObject({ status: "uncertain", reason: "disconnected", fileName: FILE_NAME });
    expect(ownChecks(drive)).toHaveLength(0);
  });

  it("never reports success when Drive is disconnected as Google answers", async () => {
    const drive = new FakeDrive();
    const session = fakeSession(drive);
    const saver = createDriveReportSaver({
      session,
      fetchImpl: async (input, init) => {
        const response = await drive.fetch(input, init);
        if (new URL(input).pathname === "/upload/drive/v3/files") session.disconnect();
        return response;
      },
    });
    expect(await saver.save(upload())).toMatchObject({ status: "uncertain", reason: "disconnected" });
  });

  it("forgets folder ids when Drive is disconnected", async () => {
    const { drive, saver, session } = setup();
    expectSaved(await saver.save(upload()));
    const month = drive.folderAt(...PATH)!;
    // While connected, the remembered folder is only checked by id.
    let before = drive.requests.length;
    expectSaved(await saver.save(upload()));
    expect(drive.requests.slice(before).some((r) => r.url.pathname === `/drive/v3/files/${month.id}`)).toBe(true);

    // After a disconnect (another account may connect next) the folders are
    // looked up again by name, not by remembered id.
    session.disconnect();
    session.reconnect();
    before = drive.requests.length;
    expectSaved(await saver.save(upload()));
    const after = drive.requests.slice(before);
    expect(after.some((r) => r.url.pathname === `/drive/v3/files/${month.id}`)).toBe(false);
    expect(after.filter((r) => (r.url.searchParams.get("q") ?? "").includes(FOLDER_MIME))).toHaveLength(3);
  });

  it("keeps errors free of tokens and file contents", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "network");
    drive.failNext(isUpload, "network");
    const result = await saver.save(upload());
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("%PDF");
  });
});

describe("security", () => {
  it("sends every request to Google only, with the token only in the Authorization header", async () => {
    const { drive, saver } = setup();
    drive.failNext(isUpload, "network");
    await saver.save(upload());
    expect(drive.requests.length).toBeGreaterThan(5);
    for (const request of drive.requests) {
      expect(request.url.origin).toBe("https://www.googleapis.com");
      expect(request.url.href).not.toContain(TOKEN);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.has("X-Access-Code")).toBe(false);
      expect(request.init.credentials).toBe("omit");
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { drive, saver } = setup();
    drive.failNext(isUpload, "lost");
    await saver.save(upload());
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  const sources = ["./drive-report-upload.ts", "./drive-folders.ts"].map((path) => [
    path,
    readFileSync(new URL(path, import.meta.url), "utf-8"),
  ]);

  it.each(sources)("%s never uses browser storage, cookies or the console", (_path, source) => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it.each(sources)("%s never uses the AuditFlow backend, the access code or a model", (_path, source) => {
    expect(source).not.toMatch(/apiFetch|api-client|X-Access-Code|API_BASE|anthropic/i);
  });

  it.each(sources)("%s only creates files: no update, replace or delete", (_path, source) => {
    expect(source).not.toMatch(/"(PATCH|PUT|DELETE)"|uploadType: "(media|resumable)"|\/copy\b/);
  });
});
