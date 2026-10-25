import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The AuditFlow backend client, mocked so the tests can prove saving to
// Drive never goes through it.
vi.mock("./api-client", () => ({
  apiFetch: vi.fn(async () => new Response("{}", { status: 200 })),
  friendlyApiError: vi.fn(async () => null),
}));

import { DriveSaveButton, DriveSaveView } from "../components/drive-save-button";
import type { Workpaper } from "../types/workpaper";
import { apiFetch } from "./api-client";
import { createDriveReportSaver, type DriveSaveResult } from "./drive-report-upload";
import {
  DriveSaveFlow,
  noticeFor,
  saveReportToDrive,
  showsDriveSave,
  type DriveSaveModules,
  type DriveSaveNotice,
  type DriveSaveReport,
} from "./drive-save-flow";
import { workpaperPayloadFallback } from "./mock-workpaper";
import { generateReportPdf, reportPdfFileNameFor, type ReportPdfInput } from "./report-pdf";
import { toReportContent } from "./report-pdf-document";
import { SAMPLE_CASE_IDS, sampleCaseDocuments } from "./sample-case-documents";
import { FakeDrive, fakeSession, TINY_PDF, TOKEN, type RecordedRequest } from "./testing/fake-drive";
import { extractPdfText } from "./testing/pdf-text";

const CASE_14: Workpaper = JSON.parse(
  readFileSync(new URL("./fixtures/case-14-workpaper.json", import.meta.url), "utf8"),
);
const COMPLETED_AT = new Date(2026, 9, 25, 9, 5, 7);
const FILE_NAME = "AuditFlow_Report_Case-14_2026-10-25_090507.pdf";
const report = (extra: Partial<DriveSaveReport> = {}): DriveSaveReport => ({
  workpaper: CASE_14,
  completedAt: COMPLETED_AT,
  companyName: null,
  ...extra,
});

// The real generator and the real saver, against the fake Drive API.
function setup() {
  const drive = new FakeDrive();
  const session = fakeSession(drive);
  const saver = createDriveReportSaver({ session, fetchImpl: drive.fetch, wait: async () => {} });
  const modules: DriveSaveModules = {
    loadGenerator: async () => ({ generateReportPdf, reportPdfFileNameFor }),
    loadSaver: async () => ({ getDriveReportSaver: () => saver }),
  };
  return { drive, session, saver, modules };
}

const isUpload = (r: RecordedRequest) => r.url.pathname === "/upload/drive/v3/files";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("when the Save to Google Drive action shows", () => {
  const all = { driveConfigured: true, driveState: "connected", hasCompletedReport: true } as const;

  it("shows with the feature flag on, Drive connected and a completed report", () => {
    expect(showsDriveSave(all)).toBe(true);
  });

  it("is hidden when the feature flag is off", () => {
    expect(showsDriveSave({ ...all, driveConfigured: false })).toBe(false);
  });

  it.each(["disconnected", "connecting", "expired"] as const)("is hidden while Drive is %s", (driveState) => {
    expect(showsDriveSave({ ...all, driveState })).toBe(false);
  });

  it("is hidden without a completed report", () => {
    expect(showsDriveSave({ ...all, hasCompletedReport: false })).toBe(false);
  });

  it("renders nothing here, where the Drive variables aren't set and Drive isn't connected", () => {
    expect(renderToStaticMarkup(createElement(DriveSaveButton, { report: report() }))).toBe("");
    expect(renderToStaticMarkup(createElement(DriveSaveButton, { report: null }))).toBe("");
  });
});

describe("the button and its messages", () => {
  const view = (props: Partial<Parameters<typeof DriveSaveView>[0]>) =>
    renderToStaticMarkup(
      createElement(DriveSaveView, { visible: true, saving: false, notice: null, onSave: () => {}, ...props }),
    );

  it("renders nothing when hidden and there is nothing to report", () => {
    expect(view({ visible: false })).toBe("");
  });

  it("is a separate, enabled Save to Google Drive button", () => {
    const html = view({});
    expect(html).toContain("Save to Google Drive");
    expect(html).not.toContain("Save PDF report");
    expect(html).not.toMatch(/disabled/);
  });

  it("is disabled and says so while saving", () => {
    const html = view({ saving: true });
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Saving to Google Drive…");
  });

  it.each([
    ["ok", 'class="send-message ok" role="status"'],
    ["warning", 'class="send-notice" role="alert"'],
    ["problem", 'class="send-message problem" role="alert"'],
  ] as const)("shows a %s message", (tone, markup) => {
    const html = view({ notice: { tone, text: "Message text" } });
    expect(html).toContain(`<p ${markup}>Message text</p>`);
  });

  it("keeps the last outcome visible after Drive disconnects, without the button", () => {
    const html = view({ visible: false, notice: { tone: "warning", text: "Upload not confirmed." } });
    expect(html).toContain("Upload not confirmed.");
    expect(html).not.toContain("<button");
  });
});

describe("saving the completed report", () => {
  it("shows the confirmed file name and destination after a successful save", async () => {
    const { drive, modules } = setup();
    const notice = await saveReportToDrive(report(), modules);
    expect(notice).toEqual({
      tone: "ok",
      text: `Saved to Google Drive as “${FILE_NAME}” in My Drive › AuditFlow › No company named › 2026-10.`,
    });
    const [file] = [...drive.items.values()].filter((item) => item.mimeType === "application/pdf");
    expect(file.name).toBe(FILE_NAME);
    expect(new TextDecoder().decode(file.bytes!.subarray(0, 5))).toBe("%PDF-");
  });

  it("saves the same bytes the generator makes, under the app's company name", async () => {
    const { drive, modules } = setup();
    await saveReportToDrive(report({ companyName: "Kaveri Traders" }), modules);
    const expected = await generateReportPdf({
      workpaper: CASE_14,
      completedAt: COMPLETED_AT,
      companyName: "Kaveri Traders",
      sourceDocuments: sampleCaseDocuments("CASE_14"),
    });
    const month = drive.folderAt("AuditFlow", "Kaveri Traders", "2026-10")!;
    const [file] = drive.children(month.id);
    // Each PDF gets its own creation time and random document /ID, so
    // compare everything but those.
    const strip = (bytes: Uint8Array) =>
      Buffer.from(bytes)
        .toString("latin1")
        .replace(/\(D:\d+Z\)/, "")
        .replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/, "");
    expect(strip(file.bytes!)).toBe(strip(expected));
  });

  it("shows the saver's safe message when the save fails", async () => {
    const { drive, modules } = setup();
    drive.failNext(isUpload, 403);
    expect(await saveReportToDrive(report(), modules)).toEqual({
      tone: "problem",
      text: "Google Drive didn't allow AuditFlow to save the report.",
    });
  });

  it("warns, and says where to look, when the upload can't be confirmed", async () => {
    const { drive, modules } = setup();
    drive.failNext(isUpload, "network");
    drive.failNext(isUpload, "network");
    const notice = await saveReportToDrive(report(), modules);
    expect(notice.tone).toBe("warning");
    expect(notice.text).toMatch(/^Upload not confirmed\. AuditFlow can't tell whether the report was saved/);
    expect(notice.text).toContain(`Look for “${FILE_NAME}” in My Drive › AuditFlow › No company named › 2026-10 before saving again.`);
  });

  it("never reports success when Drive is disconnected during the save", async () => {
    const { drive, session, modules } = setup();
    drive.failNext(isUpload, "hang");
    const pending = saveReportToDrive(report(), modules);
    await vi.waitFor(() => expect(drive.requests.some(isUpload)).toBe(true));
    session.disconnect();
    const notice = await pending;
    expect(notice.tone).toBe("warning");
    expect(notice.text).not.toMatch(/^Saved/);
  });

  it("asks to connect when Drive was disconnected before the save", async () => {
    const { drive, session, modules } = setup();
    session.disconnect();
    expect(await saveReportToDrive(report(), modules)).toEqual({
      tone: "problem",
      text: "Connect Google Drive to save the report.",
    });
    expect(drive.requests).toHaveLength(0);
  });

  it("reports a report that can't be made, without contacting Drive", async () => {
    const { drive, modules } = setup();
    // The offline sample result has items needing review but no finding details.
    const notice = await saveReportToDrive(report({ workpaper: workpaperPayloadFallback }), modules);
    expect(notice).toEqual({ tone: "problem", text: "The report couldn't be prepared for Google Drive. Try again." });
    expect(drive.requests).toHaveLength(0);
  });

  it("calls neither the AuditFlow backend nor a model, and sends nothing but Drive requests", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const { drive, modules } = setup();
    await saveReportToDrive(report(), modules);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(drive.requests.length).toBeGreaterThan(0);
    for (const request of drive.requests) {
      expect(request.url.origin).toBe("https://www.googleapis.com");
      expect(request.url.href).not.toContain(TOKEN);
      expect(request.headers.has("X-Access-Code")).toBe(false);
    }
  });

  it.each([
    [{ status: "saved", fileId: "a", fileName: "R.pdf", folderPath: [], message: "Saved." }, "ok"],
    [{ status: "uncertain", reason: "network", fileName: "R.pdf", folderPath: [], message: "Look." }, "warning"],
    [{ status: "failed", reason: "permission", message: "No." }, "problem"],
  ] as const)("maps a %j result to a %s message", (result, tone) => {
    expect(noticeFor(result as DriveSaveResult).tone).toBe(tone);
  });
});

describe("source documents in the saved report", () => {
  const CASE_14_FILES = ["BNK-1014.txt", "INV-1014.txt", "LED-1014.txt", "PO-1014.txt", "REC-1014.txt"];

  // The real generator, recording what it was asked to make.
  function recordingModules(saver: ReturnType<typeof createDriveReportSaver>) {
    const inputs: ReportPdfInput[] = [];
    const modules: DriveSaveModules = {
      loadGenerator: async () => ({
        generateReportPdf: (input: ReportPdfInput) => {
          inputs.push(input);
          return generateReportPdf(input);
        },
        reportPdfFileNameFor,
      }),
      loadSaver: async () => ({ getDriveReportSaver: () => saver }),
    };
    return { inputs, modules };
  }

  it("lists all five Case 14 source files in the PDF saved to Drive, not just INV-1014", async () => {
    const { drive, saver } = setup();
    const { inputs, modules } = recordingModules(saver);
    expect((await saveReportToDrive(report(), modules)).tone).toBe("ok");
    expect(inputs[0].sourceDocuments).toEqual(CASE_14_FILES);

    // Read the text back out of the bytes Drive received.
    const [file] = [...drive.items.values()].filter((item) => item.mimeType === "application/pdf");
    const lines = extractPdfText(file.bytes!).text.split("\n");
    CASE_14_FILES.forEach((name, index) => expect(lines).toContain(`${index + 1} ${name}`));
    expect(lines).not.toContain("6 INV-1014");
    // The finding still cites only INV-1014.
    expect(lines).toContain("Related documents INV-1014");
  });

  it.each(SAMPLE_CASE_IDS)("passes %s's complete source file list to the generator", async (caseId) => {
    const { saver } = setup();
    const { inputs, modules } = recordingModules(saver);
    // A clean result for this case: it cites only its first document.
    const files = sampleCaseDocuments(caseId)!;
    const firstId = files[0].replace(/\.txt$/, "");
    const workpaper: Workpaper = {
      case_id: caseId,
      rows: [{ ...CASE_14.rows[0], document: firstId, finding: "Clean", evidence: [firstId], action: "auto_clear" }],
      summary: { ...CASE_14.summary, auto_cleared: 1, human_review: 0, critical: 0 },
      findings: [],
    };
    expect((await saveReportToDrive(report({ workpaper }), modules)).tone).toBe("ok");
    expect(inputs[0].sourceDocuments).toEqual(files);
    expect(toReportContent(inputs[0]).documents.map((document) => document.name)).toEqual(files);
  });

  it("keeps an upload run's own uploaded files and document mapping", async () => {
    const { saver } = setup();
    const { inputs, modules } = recordingModules(saver);
    const workpaper: Workpaper = {
      ...CASE_14,
      case_id: "UPLOADED_1761380000000",
      uploaded_files: ["Invoice scan.pdf", "Bank statement.pdf"],
      documents: [
        { doc_id: "INV-1014", source_file: "Invoice scan.pdf" },
        { doc_id: "BNK-1014", source_file: "Bank statement.pdf" },
      ],
    };
    expect((await saveReportToDrive(report({ workpaper, companyName: "Kaveri Traders" }), modules)).tone).toBe("ok");
    expect(inputs[0].sourceDocuments).toBeUndefined();
    expect(toReportContent(inputs[0]).documents).toEqual([
      { name: "Invoice scan.pdf", documentIds: ["INV-1014"] },
      { name: "Bank statement.pdf", documentIds: ["BNK-1014"] },
    ]);
  });
});

describe("upload runs the backend labels CASE_<digits>", () => {
  // Modelled on a real upload run seen in manual testing: the backend runs
  // uploads under a synthetic case ID such as CASE_922486 and returns the
  // uploaded files and their document map. The finding is Case 14's, from
  // the saved fixture, since these were Case 14's documents as PDFs.
  const UPLOADED = ["BNK-1014.pdf", "INV-1014.pdf", "LED-1014.pdf", "PO-1014.pdf", "REC-1014.pdf"];
  const uploadWorkpaper: Workpaper = {
    ...CASE_14,
    case_id: "CASE_922486",
    uploaded_files: UPLOADED,
    documents: UPLOADED.map((name) => ({ doc_id: name.replace(/\.pdf$/, ""), source_file: name })),
  };

  async function saveAndRead(workpaper: Workpaper, companyName: string | null) {
    const { drive, modules } = setup();
    const notice = await saveReportToDrive(report({ workpaper, companyName }), modules);
    const [file] = [...drive.items.values()].filter((item) => item.mimeType === "application/pdf");
    const text = extractPdfText(file.bytes!).text;
    return { notice, file, text, lines: text.split("\n") };
  }

  it("names and labels the report as uploaded documents, not as a case", async () => {
    const { notice, file, lines, text } = await saveAndRead(uploadWorkpaper, "Kaveri Traders");
    const name = "AuditFlow_Report_Uploaded-documents_2026-10-25_090507.pdf";
    expect(file.name).toBe(name);
    expect(notice).toEqual({
      tone: "ok",
      text: `Saved to Google Drive as “${name}” in My Drive › AuditFlow › Kaveri Traders › 2026-10.`,
    });
    expect(lines).toContain("Case Not applicable (uploaded documents)");
    expect(lines).toContain("Source Uploaded documents");
    expect(lines.some((line) => line.startsWith("Uploaded documents · 25 October 2026, 09:05:07"))).toBe(true);
    expect(text).not.toMatch(/922486|Sample case/);
  });

  it("keeps the company, uploaded files, document IDs and finding unchanged", async () => {
    const { lines, text } = await saveAndRead(uploadWorkpaper, "Kaveri Traders");
    const [finding] = CASE_14.findings!;
    expect(lines).toContain("Company Kaveri Traders");
    expect(lines).toContain("# File Read as");
    UPLOADED.forEach((name, index) =>
      expect(lines).toContain(`${index + 1} ${name} ${name.replace(/\.pdf$/, "")}`),
    );
    expect(lines).toContain("Finding 1 of 1: Tax calculation mismatch");
    expect(lines).toContain("Reference AF-a14c61b6b9");
    expect(text.replace(/\s+/g, " ")).toContain(finding.explanation);
    expect(lines).toContain("Main document INV-1014");
    expect(lines).toContain("Related documents INV-1014");
    expect(lines).toContain("Confidence 97%");
  });

  it("still names and labels sample Case 14 as Case 14, with its five source files", async () => {
    const { notice, file, lines } = await saveAndRead(CASE_14, null);
    expect(file.name).toBe(FILE_NAME);
    expect(notice.text).toContain(`“${FILE_NAME}”`);
    expect(lines).toContain("Case Case 14 (CASE_14)");
    expect(lines).toContain("Source Sample case (Case 14)");
    ["BNK-1014.txt", "INV-1014.txt", "LED-1014.txt", "PO-1014.txt", "REC-1014.txt"].forEach((name, index) =>
      expect(lines).toContain(`${index + 1} ${name}`),
    );
  });
});

describe("repeated clicks", () => {
  it("start only one save while one is running", async () => {
    let finish: (notice: DriveSaveNotice) => void = () => {};
    const run = vi.fn(() => new Promise<DriveSaveNotice>((resolve) => (finish = resolve)));
    const flow = new DriveSaveFlow(run);
    const phases: string[] = [];
    flow.subscribe(() => phases.push(flow.getPhase()));

    const first = flow.start(report());
    expect(flow.getPhase()).toBe("saving");
    expect(await flow.start(report())).toBeNull();
    expect(await flow.start(report())).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);

    finish({ tone: "ok", text: "Saved." });
    expect(await first).toEqual({ tone: "ok", text: "Saved." });
    expect(flow.getNotice()).toEqual({ tone: "ok", text: "Saved." });
    expect(phases).toEqual(["saving", "idle"]);

    // Free again afterwards; a new save clears the old message while it runs.
    void flow.start(report());
    expect(flow.getNotice()).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never upload twice, even if the same saver is asked twice at once", async () => {
    const { drive, modules } = setup();
    const [a, b] = await Promise.all([saveReportToDrive(report(), modules), saveReportToDrive(report(), modules)]);
    expect([a.tone, b.tone].sort()).toEqual(["ok", "problem"]);
    expect([a.text, b.text]).toContain("A report is already being saved to Google Drive. Wait for it to finish.");
    expect(drive.requests.filter(isUpload)).toHaveLength(1);
  });
});

describe("lazy loading", () => {
  it("imports the generator and the saver only when saving", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    const saved: DriveSaveResult = { status: "saved", fileId: "f1", fileName: "R.pdf", folderPath: ["AuditFlow"], message: "Saved." };
    vi.doMock("./report-pdf", () => {
      loaded.push("report-pdf");
      return { generateReportPdf: async () => TINY_PDF, reportPdfFileNameFor: () => "R.pdf" };
    });
    vi.doMock("./drive-report-upload", () => {
      loaded.push("drive-report-upload");
      return { getDriveReportSaver: () => ({ save: async () => saved }) };
    });
    try {
      const flow = await import("./drive-save-flow");
      expect(loaded).toEqual([]);
      expect(await flow.saveReportToDrive(report())).toEqual({ tone: "ok", text: "Saved." });
      expect([...loaded].sort()).toEqual(["drive-report-upload", "report-pdf"]);
    } finally {
      vi.doUnmock("./report-pdf");
      vi.doUnmock("./drive-report-upload");
      vi.resetModules();
    }
  });
});

describe("source", () => {
  // Line endings normalised: a Windows checkout may use CRLF.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  const app = read("../components/audit-flow-app.tsx");
  const flow = read("./drive-save-flow.ts");
  const button = read("../components/drive-save-button.tsx");

  it("keeps the Save PDF report button: same class, click handler, icon and label, shown for backend results", () => {
    // Moved into the results action row; its hint moved to the row's caption.
    expect(app).toContain(
      [
        "              backendLoaded ? (",
        "                <button",
        '                  className="secondary-button"',
        "                  onClick={saveReport}",
        "                  aria-describedby={SAVE_PDF_HINT_ID}",
        "                >",
        '                  <Icon name="note" size={15} />',
        "                  <span>Save PDF report</span>",
        "                </button>",
        "              ) : null",
      ].join("\n"),
    );
    expect(app).toContain(`{"Save PDF report opens your browser's print window. Choose Save as PDF."}`);
  });

  it("keeps Save PDF report's print-window handler exactly as it was", () => {
    expect(app).toContain(
      [
        "  const saveReport = () => {",
        "    if (!workpaper || !completedRun) return;",
        "    const previousTitle = document.title;",
        "    // Local calendar date, so the file name matches the date in the report",
        "    // (toISOString would give the UTC date).",
        "    const { completedAt } = completedRun;",
        "    const date = [",
        "      completedAt.getFullYear(),",
        '      String(completedAt.getMonth() + 1).padStart(2, "0"),',
        '      String(completedAt.getDate()).padStart(2, "0"),',
        '    ].join("-");',
        "    // The page title becomes the browser's suggested PDF file name.",
        "    const reportName =",
        "      completedRun.uploadedFileCount > 0",
        '        ? "uploaded documents"',
        "        : workpaper.case_id;",
        "    document.title = `AuditFlow report – ${reportName} – ${date}`;",
        "    const restoreTitle = () => {",
        "      document.title = previousTitle;",
        '      window.removeEventListener("afterprint", restoreTitle);',
        "    };",
        '    window.addEventListener("afterprint", restoreTitle);',
        "    window.print();",
        "  };",
      ].join("\n"),
    );
    expect(app.match(/window\.print\(\)/g)).toHaveLength(1);
    expect(app.match(/onClick=\{saveReport\}/g)).toHaveLength(1);
  });

  it("adds the Drive button separately, for completed results, with the app's company field", () => {
    expect(app).toContain("<DriveSaveButton");
    expect(app).toContain("isComplete && backendLoaded && workpaper && completedRun");
    expect(app).toContain("companyName: ranOnUpload ? company : null");
    expect(button).not.toContain("saveReport");
    expect(button).not.toMatch(/window\.print|afterprint|PrintReport/);
  });

  it("loads the generator and saver only on demand, so they stay out of the first page load", () => {
    expect(flow).toContain('import("./report-pdf")');
    expect(flow).toContain('import("./drive-report-upload")');
    for (const source of [app, flow, button]) {
      expect(source).not.toMatch(/^import (?!type)[^;]*["']\.\.?\/(lib\/)?(report-pdf|drive-report-upload|drive-folders)["']/m);
      expect(source).not.toMatch(/^import (?!type)[^;]*["']pdfmake/m);
    }
  });

  it.each([
    ["drive-save-flow.ts", flow],
    ["drive-save-button.tsx", button],
  ])("%s uses no backend, access code, storage, console or model", (_, source) => {
    expect(source).not.toMatch(/apiFetch|api-client|X-Access-Code|API_BASE|anthropic/i);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });
});
