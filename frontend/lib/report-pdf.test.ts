import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// The backend client, mocked so the tests can prove PDF generation never
// goes through it.
vi.mock("./api-client", () => ({
  apiFetch: vi.fn(async () => new Response("{}", { status: 200 })),
  friendlyApiError: vi.fn(async () => null),
}));

import type { Workpaper } from "../types/workpaper";
import { apiFetch } from "./api-client";
import { workpaperPayloadFallback } from "./mock-workpaper";
import { generateReportPdf, reportPdfFileName, reportPdfFileNameFor, ReportPdfDataError } from "./report-pdf";
import { extractPdfText } from "./testing/pdf-text";
import {
  buildReportDocument,
  isUploadedRun,
  CONFIDENCE_NOTE,
  formatReportDate,
  NO_COMPANY_NAME,
  toReportContent,
  wrapLongWords,
  ZERO_WIDTH_SPACE,
  type PdfDocumentDefinition,
} from "./report-pdf-document";

// Saved verbatim from one run of the real pipeline on dataset/CASE_14
// (run_full_pipeline, 2026-10-25). The explanation and row label are the
// model's own words from that run.
const CASE_14: Workpaper = JSON.parse(
  readFileSync(new URL("./fixtures/case-14-workpaper.json", import.meta.url), "utf8"),
);
// The real Case 14 source folder: its file names are what the report lists;
// its contents must never appear in the report.
const CASE_14_DIR = new URL("../../dataset/CASE_14/", import.meta.url);
const CASE_14_FILES = readdirSync(CASE_14_DIR).sort();
const CASE_14_SOURCES = CASE_14_FILES.map((name) => readFileSync(new URL(name, CASE_14_DIR), "utf8"));

// Local time, so the expected date and file name don't depend on the time
// zone the tests run in.
const COMPLETED_AT = new Date(2026, 9, 25, 9, 5, 7);
// Stands in for what a user typed in the app's Company name field. Not
// taken from the Case 14 documents.
const COMPANY = "Example Typed Company Ltd";

// Not Case 14: a made-up upload run, used only where Case 14 has no example
// (it has no rupee sign, no accented name and no long text).
function uploadRun(overrides: Partial<Workpaper> = {}): Workpaper {
  return {
    case_id: "UPLOADED_1761380000000",
    rows: [
      {
        document: "INV-2001",
        finding: "Amount mismatch",
        evidence: ["INV-2001", "PO-2001"],
        confidence: 0.82,
        action: "human_review",
      } as Workpaper["rows"][number],
    ],
    summary: {
      items_reviewed: 1,
      auto_cleared: 0,
      human_review: 1,
      critical: 1,
      assumed_minutes_per_item: 3,
      estimated_minutes_saved: 0,
    },
    findings: [
      {
        finding_id: "AF-0000000001",
        type: "amount_mismatch",
        label: "Amount mismatch",
        row_document: "INV-2001",
        primary_document: "INV-2001",
        documents: ["INV-2001", "PO-2001"],
        transaction_documents: ["INV-2001", "PO-2001"],
        severity: "high",
        confidence: 0.82,
        explanation:
          "INV-2001 from Société Générale Müller states ₹1,18,000.00 but PO-2001 approved ₹1,00,000.00.",
      },
    ],
    documents: [
      { doc_id: "INV-2001", source_file: "Facture_Café_Zoë.pdf" },
      { doc_id: "PO-2001", source_file: "Bestellung_Jürgen_Ñúñez.pdf" },
    ],
    uploaded_files: ["Facture_Café_Zoë.pdf", "Bestellung_Jürgen_Ñúñez.pdf"],
    ...overrides,
  };
}

/** Every piece of text the report shows, footer included. */
function reportText(definition: PdfDocumentDefinition): string {
  // A node with `text` is a text node; any other object (table, columns)
  // only holds other nodes and layout settings.
  const strings = (node: unknown): string[] => {
    if (typeof node === "string") return [node];
    if (Array.isArray(node)) return node.flatMap(strings);
    if (node && typeof node === "object") {
      return "text" in node ? strings(node.text) : Object.values(node).flatMap(strings);
    }
    return [];
  };
  return [...strings(definition.content), ...strings(definition.footer(1, 2))]
    .join("\n")
    .replaceAll(ZERO_WIDTH_SPACE, "");
}

const textOf = (input: Parameters<typeof buildReportDocument>[0]) =>
  reportText(buildReportDocument(input));

const ascii = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
const pageCount = (bytes: Uint8Array) => ascii(bytes).match(/\/Type \/Page\b(?!s)/g)?.length ?? 0;

describe("generating the PDF", () => {
  it("returns real PDF bytes for the Case 14 result", async () => {
    const bytes = await generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT, companyName: COMPANY });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(ascii(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(ascii(bytes.subarray(-6)).trim()).toBe("%%EOF");
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  it("makes no backend request, model call or other network request", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const xhrSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhrSpy);
    try {
      await generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT });
      await generateReportPdf({ workpaper: uploadRun(), completedAt: COMPLETED_AT });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("loads pdfmake only through a dynamic import, and never imports the backend client", () => {
    for (const file of ["./report-pdf.ts", "./report-pdf-document.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/^\s*import\s[^;]*["']pdfmake/m);
      expect(source).not.toMatch(/api-client|fetch\(|XMLHttpRequest|anthropic/i);
    }
    const loader = readFileSync(new URL("./report-pdf.ts", import.meta.url), "utf8");
    expect(loader).toContain('import("pdfmake/build/pdfmake")');
    expect(loader).toContain('import("pdfmake/build/vfs_fonts")');
  });

  it("rejects bad report data before loading pdfmake", async () => {
    await expect(
      generateReportPdf({ workpaper: { ...CASE_14, case_id: "" }, completedAt: COMPLETED_AT }),
    ).rejects.toBeInstanceOf(ReportPdfDataError);
  });
});

describe("text extracted from the generated PDF bytes", () => {
  const case14 = async () =>
    extractPdfText(
      await generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT, sourceDocuments: CASE_14_FILES }),
    );

  it("keeps words with f-i letter pairs intact (no ligature glyphs)", async () => {
    const { text, multiCharacterGlyphs, missingGlyphs } = await case14();
    for (const word of ["Finding 1 of 1", "finding should be reviewed", "Confidence is for reference.", "qualified"]) {
      expect(text).toContain(word);
    }
    expect(text).not.toMatch(/fnding|Confdence|qualifed/);
    // The cause of the earlier bug: "fi" drawn as one glyph whose only text
    // was a two-character ToUnicode entry. Every glyph must map to one character.
    expect(multiCharacterGlyphs).toEqual([]);
    expect(missingGlyphs).toBe(0);
  });

  it("disables ligatures with the object form fontkit honours", () => {
    const { defaultStyle } = buildReportDocument({ workpaper: CASE_14, completedAt: COMPLETED_AT });
    expect(defaultStyle.fontFeatures).toEqual({ liga: false, clig: false });
  });

  it("contains the real Case 14 finding and all five file names, and nothing from inside the files", async () => {
    const { text } = await case14();
    const [finding] = CASE_14.findings!;
    expect(text).toContain("Tax calculation mismatch");
    expect(text).toContain("AF-a14c61b6b9");
    // The explanation wraps over several lines in the PDF.
    expect(text.replace(/\s+/g, " ")).toContain(finding.explanation);
    for (const name of CASE_14_FILES) expect(text).toContain(name);
    const sourceLines = CASE_14_SOURCES.flatMap((source) => source.split(/\r?\n/))
      .map((line) => line.trim())
      .filter((line) => line.length >= 10);
    for (const line of sourceLines) expect(text).not.toContain(line);
    expect(text).not.toMatch(/severity|critical/i);
  });
});

describe("synthetic rendering check (not Case 14)", () => {
  // Made-up input, used only because Case 14 has no rupee sign or accented
  // names. It is not evidence about any real case.
  const RENDERING_LINE = "Rendering check: Société Générale Müller — ₹1,18,000.00";
  const input = {
    workpaper: uploadRun({
      findings: [
        {
          ...uploadRun().findings![0],
          label: "Synthetic rendering check",
          explanation: `${RENDERING_LINE}. Synthetic test data, not Case 14.`,
        },
      ],
    }),
    completedAt: COMPLETED_AT,
    companyName: "Société Générale Müller",
  };

  it("produces a real PDF whose extracted text keeps the rupee sign and accented names", async () => {
    const bytes = await generateReportPdf(input);
    expect(ascii(bytes.subarray(0, 5))).toBe("%PDF-");

    const extracted = extractPdfText(bytes);
    const { multiCharacterGlyphs, missingGlyphs } = extracted;
    // Wrapped lines joined, so a sentence split over two lines still matches.
    const text = extracted.text.replace(/\s+/g, " ");
    expect(text).toContain(RENDERING_LINE);
    expect(text).toContain("Société Générale Müller");
    expect(text).toContain("₹1,18,000.00");
    expect(text).toContain("Facture_Café_Zoë.pdf");
    expect(text).toContain("Bestellung_Jürgen_Ñúñez.pdf");
    expect(text).toContain("Synthetic test data, not Case 14.");
    expect(text).not.toContain("CASE_14");
    // No glyph falls back to .notdef (the box a viewer draws for a missing glyph).
    expect(missingGlyphs).toBe(0);
    expect(multiCharacterGlyphs).toEqual([]);
  });
});

describe("lazy loading", () => {
  it("imports pdfmake and its fonts only when a PDF is generated, once", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock("pdfmake/build/pdfmake", async (importOriginal) => {
      loaded.push("pdfmake");
      return importOriginal();
    });
    vi.doMock("pdfmake/build/vfs_fonts", async (importOriginal) => {
      loaded.push("fonts");
      return importOriginal();
    });
    try {
      const reportPdf = await import("./report-pdf");
      expect(loaded).toEqual([]);

      await reportPdf.generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT });
      expect([...loaded].sort()).toEqual(["fonts", "pdfmake"]);

      await reportPdf.generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT });
      expect(loaded).toHaveLength(2);
    } finally {
      vi.doUnmock("pdfmake/build/pdfmake");
      vi.doUnmock("pdfmake/build/vfs_fonts");
      vi.resetModules();
    }
  });

  it("does not load pdfmake when the report data is rejected", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock("pdfmake/build/pdfmake", async (importOriginal) => {
      loaded.push("pdfmake");
      return importOriginal();
    });
    try {
      const reportPdf = await import("./report-pdf");
      await expect(
        reportPdf.generateReportPdf({ workpaper: { ...CASE_14, case_id: "" }, completedAt: COMPLETED_AT }),
      ).rejects.toThrow();
      expect(loaded).toEqual([]);
    } finally {
      vi.doUnmock("pdfmake/build/pdfmake");
      vi.resetModules();
    }
  });
});

describe("Case 14 report content", () => {
  const input = {
    workpaper: CASE_14,
    completedAt: COMPLETED_AT,
    companyName: COMPANY,
    sourceDocuments: CASE_14_FILES,
  };
  const content = toReportContent(input);
  const text = textOf(input);
  const [finding] = CASE_14.findings ?? [];

  it("uses the real Case 14 result and source folder", () => {
    expect(CASE_14.case_id).toBe("CASE_14");
    expect(CASE_14.findings).toHaveLength(1);
    expect(finding.type).toBe("tax_mismatch");
    expect(finding.primary_document).toBe("INV-1014");
    // The result itself names only the document its finding cites.
    expect(CASE_14.uploaded_files).toBeUndefined();
    expect(CASE_14.documents).toBeUndefined();
    expect(CASE_14_FILES).toEqual(["BNK-1014.txt", "INV-1014.txt", "LED-1014.txt", "PO-1014.txt", "REC-1014.txt"]);
  });

  it("shows the company name, the report date and the case", () => {
    expect(text).toContain(COMPANY);
    expect(content.reportDate).toMatch(/^25 October 2026, 09:05:07 \(UTC[+-]\d\d:\d\d\)$/);
    expect(text).toContain(content.reportDate);
    expect(content.caseId).toBe("CASE_14");
    expect(text).toContain("Case 14 (CASE_14)");
    expect(text).toContain("Sample case (Case 14)");
  });

  it("lists all five source files once each, with no extra entry for the cited INV-1014", () => {
    const names = content.documents.map((document) => document.name);
    expect(names).toEqual(CASE_14_FILES);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("INV-1014");
    for (const name of CASE_14_FILES) expect(text).toContain(name);
  });

  it("falls back to the cited document IDs when no source list is given", () => {
    const documents = toReportContent({ workpaper: CASE_14, completedAt: COMPLETED_AT }).documents;
    expect(documents).toEqual([{ name: "INV-1014", documentIds: [] }]);
  });

  it("still lists a cited document that has no file in the source list", () => {
    const documents = toReportContent({
      ...input,
      sourceDocuments: CASE_14_FILES.filter((name) => name !== "INV-1014.txt"),
    }).documents.map((document) => document.name);
    expect(documents).toEqual(["BNK-1014.txt", "LED-1014.txt", "PO-1014.txt", "REC-1014.txt", "INV-1014"]);
  });

  it("lists repeated source names once", () => {
    const documents = toReportContent({
      ...input,
      sourceDocuments: [...CASE_14_FILES, " INV-1014.txt ", "BNK-1014.txt"],
    }).documents.map((document) => document.name);
    expect(documents).toEqual(CASE_14_FILES);
  });

  it("shows every finding with its label, explanation and related documents", () => {
    expect(content.findings).toEqual([
      {
        reference: "AF-a14c61b6b9",
        label: "Tax calculation mismatch",
        explanation: finding.explanation,
        mainDocument: "INV-1014",
        relatedDocuments: ["INV-1014"],
        confidence: 0.97,
        result: "Needs review",
      },
    ]);
    expect(text).toContain("Finding 1 of 1: Tax calculation mismatch");
    expect(text).toContain(finding.explanation);
    expect(text).toMatch(/Related documents\nINV-1014/);
    expect(text).toContain("97%");
  });

  it("includes the exact confidence note", () => {
    expect(CONFIDENCE_NOTE).toBe("Confidence is for reference.");
    expect(text).toContain("Confidence is for reference.");
  });

  it("leaves out severity", () => {
    expect(finding.severity).toBe("high");
    expect(CASE_14.summary.critical).toBe(1);
    expect(text).not.toMatch(/severity|critical|\bhigh\b|\bmedium\b|\blow\b/i);
    expect(JSON.stringify(content)).not.toMatch(/severity|critical/i);
  });

  it("leaves out the contents of every source document", () => {
    const lines = CASE_14_SOURCES.flatMap((source) => source.split(/\r?\n/))
      .map((line) => line.trim())
      .filter((line) => line.length >= 10);
    expect(lines).toContain("Description: Custom corrugated shipping cartons, bulk order");
    for (const line of lines) expect(text).not.toContain(line);
    for (const fragment of ["Custom corrugated shipping cartons", "SPS/2026/2208", "GST @ 18%", "Bill To", "Warehouse Operations"]) {
      expect(text).not.toContain(fragment);
    }
  });
});

describe("what the report leaves out", () => {
  const SECRETS = ["AFX-ACCESS-CODE-0042", "ya29.test-oauth-token-not-real", "sk-ant-not-a-real-key"];

  it("never shows access codes, OAuth tokens or keys, even if they are in the data", async () => {
    const workpaper = {
      ...CASE_14,
      access_code: SECRETS[0],
      access_token: SECRETS[1],
      findings: CASE_14.findings?.map((finding) => ({ ...finding, api_key: SECRETS[2] })),
    } as Workpaper;
    const input = { workpaper, completedAt: COMPLETED_AT, companyName: COMPANY };

    const definition = buildReportDocument(input);
    const serialized = JSON.stringify(definition) + reportText(definition);
    const pdf = ascii(await generateReportPdf(input));
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret);
      expect(pdf).not.toContain(secret);
    }
  });
});

describe("company name", () => {
  it.each([undefined, null, "", "   \n  "])("prints No company named for %j", (companyName) => {
    const content = toReportContent({ workpaper: CASE_14, completedAt: COMPLETED_AT, companyName });
    expect(content.companyName).toBeNull();
    expect(NO_COMPANY_NAME).toBe("No company named");
    expect(textOf({ workpaper: CASE_14, completedAt: COMPLETED_AT, companyName })).toMatch(/Company\nNo company named/);
  });

  it("prints the supplied name, and the fallback only when there is none, in the PDF itself", async () => {
    const named = extractPdfText(
      await generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT, companyName: COMPANY }),
    ).text;
    expect(named).toMatch(new RegExp(`^Company ${COMPANY}$`, "m"));
    expect(named).not.toContain(NO_COMPANY_NAME);

    const unnamed = extractPdfText(await generateReportPdf({ workpaper: CASE_14, completedAt: COMPLETED_AT })).text;
    expect(unnamed).toMatch(/^Company No company named$/m);
  });

  it("is never taken from the documents", () => {
    // Case 14's invoice is billed to a named company; without a typed name
    // the report still says there is none.
    expect(CASE_14_SOURCES.join("\n")).toContain("Bill To: AuditFlow Operations");
    const text = textOf({ workpaper: CASE_14, completedAt: COMPLETED_AT, sourceDocuments: CASE_14_FILES });
    expect(text).toMatch(/Company\nNo company named/);
    expect(text).not.toContain("AuditFlow Operations");
  });

  it("is trimmed and kept on one line", () => {
    const content = toReportContent({
      workpaper: CASE_14,
      completedAt: COMPLETED_AT,
      companyName: "  Sunrise\n  Packaging  ",
    });
    expect(content.companyName).toBe("Sunrise Packaging");
  });
});

describe("rupee sign and accented names", () => {
  const COMPANY_WITH_ACCENTS = "Société Générale Müller & Núñez Pvt. Ltd.";
  const input = { workpaper: uploadRun(), completedAt: COMPLETED_AT, companyName: COMPANY_WITH_ACCENTS };

  it("keeps them unchanged in the report", () => {
    const text = textOf(input);
    expect(text).toContain(COMPANY_WITH_ACCENTS);
    expect(text).toContain("₹1,18,000.00");
    expect(text).toContain("Facture_Café_Zoë.pdf");
    expect(text).toContain("Bestellung_Jürgen_Ñúñez.pdf");
  });

  it("are drawn with real glyphs from the embedded font", async () => {
    // fontkit is the font engine pdfmake uses (through pdfkit). Load the
    // exact Roboto files pdfmake embeds and check every character.
    const requireFromPdfmake = createRequire(createRequire(import.meta.url).resolve("pdfmake/package.json"));
    const fontkit = createRequire(requireFromPdfmake.resolve("pdfkit"))("fontkit") as {
      create(data: Buffer): { hasGlyphForCodePoint(codePoint: number): boolean };
    };
    const { default: vfs } = await import("pdfmake/build/vfs_fonts");
    const text = textOf(input) + textOf({ workpaper: CASE_14, completedAt: COMPLETED_AT, companyName: COMPANY });
    const characters = [...new Set(text.replace(/\s/g, ""))];
    expect(characters).toEqual(expect.arrayContaining(["₹", "é", "ü", "ñ", "Ñ", "ë", "·"]));
    for (const file of ["Roboto-Regular.ttf", "Roboto-Medium.ttf", "Roboto-Italic.ttf"]) {
      const font = fontkit.create(Buffer.from(vfs[file], "base64"));
      const missing = characters.filter((character) => !font.hasGlyphForCodePoint(character.codePointAt(0)!));
      expect(missing, file).toEqual([]);
    }

    // And the generated PDF maps them back to the same characters, so they
    // can be found and copied in a PDF viewer.
    const { default: pdfMake } = await import("pdfmake/build/pdfmake");
    pdfMake.addVirtualFileSystem(vfs);
    const uncompressed = ascii(
      await pdfMake.createPdf({ ...buildReportDocument(input), compress: false }).getBuffer(),
    ).toLowerCase();
    for (const codePoint of ["20b9", "00e9", "00fc", "00f1", "00d1", "00eb"]) {
      expect(uncompressed).toContain(`<${codePoint}>`);
    }
  });

  it("lists uploaded files with the document IDs read from them", () => {
    expect(toReportContent(input).documents).toEqual([
      { name: "Facture_Café_Zoë.pdf", documentIds: ["INV-2001"] },
      { name: "Bestellung_Jürgen_Ñúñez.pdf", documentIds: ["PO-2001"] },
    ]);
    const content = toReportContent(input);
    expect(content.caseId).toBeNull();
    expect(content.source).toBe("Uploaded documents");
  });

  it("keeps the upload run's own file list even when a source list is also given", () => {
    const documents = toReportContent({ ...input, sourceDocuments: ["Other.pdf", "INV-2001.pdf"] }).documents;
    expect(documents).toEqual(toReportContent(input).documents);
  });

  it("lists every uploaded file, including one not linked to a document", () => {
    const workpaper = uploadRun({
      uploaded_files: ["Facture_Café_Zoë.pdf", "Bestellung_Jürgen_Ñúñez.pdf", "Cover letter.pdf"],
      unmapped_files: ["Cover letter.pdf"],
    });
    const names = toReportContent({ ...input, workpaper }).documents.map((document) => document.name);
    expect(names).toEqual(["Facture_Café_Zoë.pdf", "Bestellung_Jürgen_Ñúñez.pdf", "Cover letter.pdf"]);
  });
});

describe("long content", () => {
  const LONG_FILE = `${"Very_Long_Scanned_Invoice_Name_".repeat(6)}2026.pdf`;
  const files = [LONG_FILE, ...Array.from({ length: 119 }, (_, index) => `Supporting document ${index + 1}.pdf`)];
  const explanation = Array.from(
    { length: 60 },
    (_, index) => `Sentence ${index + 1} explains the difference between the invoice and the purchase order.`,
  ).join(" ");
  const findings = Array.from({ length: 12 }, (_, index) => ({
    ...uploadRun().findings![0],
    finding_id: `AF-00000000${String(index).padStart(2, "0")}`,
    explanation,
    documents: files.slice(0, 40),
  }));
  const input = {
    workpaper: uploadRun({
      findings,
      uploaded_files: files,
      documents: files.map((source_file, index) => ({ doc_id: `DOC-${index + 1}`, source_file })),
    }),
    completedAt: COMPLETED_AT,
  };

  it("keeps every document and finding, and wraps long words", () => {
    const text = textOf(input);
    for (const file of files) expect(text).toContain(file);
    for (const finding of findings) expect(text).toContain(`${finding.finding_id}\n`);
    expect(text.split(explanation)).toHaveLength(findings.length + 1);

    const wrapped = JSON.stringify(buildReportDocument(input).content);
    expect(wrapped).not.toContain(LONG_FILE);
    expect(wrapped).toContain(wrapLongWords(LONG_FILE));
  });

  it("flows onto more pages", async () => {
    expect(pageCount(await generateReportPdf(input))).toBeGreaterThan(5);
  });

  it("splits only long words, into parts of at most 40 characters, without changing the text", () => {
    const wrapped = wrapLongWords(`short ${LONG_FILE} words`);
    expect(wrapped.replaceAll(ZERO_WIDTH_SPACE, "")).toBe(`short ${LONG_FILE} words`);
    const parts = wrapped.split(/[\s\u200B]/);
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) expect([...part].length).toBeLessThanOrEqual(40);
    expect(wrapLongWords("Bestellung_J\u00FCrgen_\u00D1\u00FA\u00F1ez.pdf")).toBe("Bestellung_J\u00FCrgen_\u00D1\u00FA\u00F1ez.pdf");
    expect(wrapLongWords("A".repeat(50), 20)).toBe(["A".repeat(20), "A".repeat(20), "A".repeat(10)].join(ZERO_WIDTH_SPACE));
  });
});

describe("invalid or incomplete report data", () => {
  const valid = { workpaper: CASE_14, completedAt: COMPLETED_AT };
  const withFinding = (change: Record<string, unknown>) => ({
    ...valid,
    workpaper: { ...CASE_14, findings: [{ ...CASE_14.findings![0], ...change }] } as Workpaper,
  });

  it.each([
    ["no input", undefined],
    ["no workpaper", { completedAt: COMPLETED_AT }],
    ["no case ID", { ...valid, workpaper: { ...CASE_14, case_id: "  " } }],
    ["an invalid date", { ...valid, completedAt: new Date("not a date") }],
    ["a missing date", { workpaper: CASE_14 }],
    ["no rows", { ...valid, workpaper: { ...CASE_14, rows: undefined } }],
    ["no summary", { ...valid, workpaper: { ...CASE_14, summary: undefined } }],
    ["a malformed findings list", { ...valid, workpaper: { ...CASE_14, findings: "none" } }],
    ["a row without a result", { ...valid, workpaper: { ...CASE_14, rows: [{ ...CASE_14.rows[0], action: "maybe" }] } }],
    ["a finding without an explanation", withFinding({ explanation: "" })],
    ["a finding without a label", withFinding({ label: undefined })],
    ["a finding without a reference", withFinding({ finding_id: null })],
    ["a finding with an invalid document list", withFinding({ documents: "INV-1014" })],
    ["a finding with confidence above 1", withFinding({ confidence: 97 })],
    ["a source document list that isn't a list of names", { ...valid, sourceDocuments: "INV-1014.txt" }],
    ["a source document list with a non-name entry", { ...valid, sourceDocuments: ["INV-1014.txt", 7] }],
    ["items needing review but no finding details", { ...valid, workpaper: workpaperPayloadFallback }],
    ["items needing review and an empty findings list", { ...valid, workpaper: { ...CASE_14, findings: [] } }],
  ])("throws ReportPdfDataError for %s", (_, input) => {
    expect(() => buildReportDocument(input as never)).toThrow(ReportPdfDataError);
  });

  it("accepts a clean result with no findings", () => {
    const clean: Workpaper = {
      case_id: "CASE_01",
      rows: [{ ...CASE_14.rows[0], document: "INV-1001", finding: "Clean", evidence: ["INV-1001", "PO-1001"], action: "auto_clear" }],
      summary: { ...CASE_14.summary, auto_cleared: 1, human_review: 0, critical: 0 },
      findings: [],
    };
    const text = textOf({ workpaper: clean, completedAt: COMPLETED_AT });
    expect(text).toContain("No findings were identified. All items can be cleared.");
    expect(text).toContain("PO-1001");
    expect(text).toContain(CONFIDENCE_NOTE);
  });
});

describe("report date", () => {
  const at = (offsetMinutes: number) =>
    Object.assign(new Date(2026, 0, 5, 1, 2, 3), { getTimezoneOffset: () => offsetMinutes });

  it("is local time with the UTC offset", () => {
    expect(formatReportDate(at(-330))).toBe("5 January 2026, 01:02:03 (UTC+05:30)");
    expect(formatReportDate(at(240))).toBe("5 January 2026, 01:02:03 (UTC-04:00)");
    expect(formatReportDate(at(0))).toBe("5 January 2026, 01:02:03 (UTC+00:00)");
  });
});

describe("report file name", () => {
  it("follows AuditFlow_Report_<case-id>_<YYYY-MM-DD>_<HHmmss>.pdf", () => {
    expect(reportPdfFileName("CASE_14", COMPLETED_AT)).toBe("AuditFlow_Report_Case-14_2026-10-25_090507.pdf");
    expect(reportPdfFileName("CASE_14", new Date(2026, 0, 5, 23, 59, 9))).toBe(
      "AuditFlow_Report_Case-14_2026-01-05_235909.pdf",
    );
    expect(reportPdfFileName("CASE_14", COMPLETED_AT)).toMatch(
      /^AuditFlow_Report_[A-Za-z0-9-]+_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/,
    );
  });

  it("uses the same local time as the report date", () => {
    const date = new Date(2026, 11, 31, 18, 30, 0);
    expect(formatReportDate(date)).toMatch(/^31 December 2026, 18:30:00/);
    expect(reportPdfFileName("CASE_14", date)).toBe("AuditFlow_Report_Case-14_2026-12-31_183000.pdf");
  });

  it("names an upload run without its internal run ID", () => {
    expect(reportPdfFileName("UPLOADED_1761380000000", COMPLETED_AT)).toBe(
      "AuditFlow_Report_Uploaded-documents_2026-10-25_090507.pdf",
    );
  });

  it.each([
    ['../evil:<name>|"*?.pdf', "AuditFlow_Report_evil-name-pdf_2026-10-25_090507.pdf"],
    ["C:\\Windows\\System32", "AuditFlow_Report_C-Windows-System32_2026-10-25_090507.pdf"],
    ["Café Zoë ₹ 14", "AuditFlow_Report_Caf-Zo-14_2026-10-25_090507.pdf"],
    ["  CASE_09\n", "AuditFlow_Report_Case-09_2026-10-25_090507.pdf"],
    ["", "AuditFlow_Report_Unnamed-case_2026-10-25_090507.pdf"],
    ["___", "AuditFlow_Report_Unnamed-case_2026-10-25_090507.pdf"],
  ])("sanitizes %j", (caseId, expected) => {
    expect(reportPdfFileName(caseId, COMPLETED_AT)).toBe(expected);
  });

  it("caps the case part's length", () => {
    const name = reportPdfFileName("X".repeat(500), COMPLETED_AT);
    expect(name).toBe(`AuditFlow_Report_${"X".repeat(60)}_2026-10-25_090507.pdf`);
  });

  it("rejects an invalid date", () => {
    expect(() => reportPdfFileName("CASE_14", new Date(Number.NaN))).toThrow(ReportPdfDataError);
  });
});

describe("upload runs the backend labels CASE_<digits>", () => {
  // The backend runs uploads under a synthetic ID like CASE_922486 (seen in
  // manual testing) and returns the uploaded files and their document map.
  const UPLOADED = ["BNK-1014.pdf", "INV-1014.pdf", "LED-1014.pdf", "PO-1014.pdf", "REC-1014.pdf"];
  const workpaper: Workpaper = {
    ...CASE_14,
    case_id: "CASE_922486",
    uploaded_files: UPLOADED,
    documents: UPLOADED.map((name) => ({ doc_id: name.replace(/\.pdf$/, ""), source_file: name })),
  };
  const input = { workpaper, completedAt: COMPLETED_AT, companyName: COMPANY };

  it("are recognised by their upload metadata, not their case ID", () => {
    expect(isUploadedRun(workpaper)).toBe(true);
    expect(isUploadedRun({ ...workpaper, documents: undefined })).toBe(true);
    expect(isUploadedRun({ ...workpaper, uploaded_files: undefined })).toBe(true);
    expect(isUploadedRun({ ...CASE_14, case_id: "UPLOADED_1761380000000" })).toBe(true);
    expect(isUploadedRun(CASE_14)).toBe(false);
    expect(isUploadedRun({ ...CASE_14, case_id: "CASE_922486" })).toBe(false);
    expect(isUploadedRun({ ...CASE_14, uploaded_files: [], documents: [] })).toBe(false);
  });

  it("are labelled as uploaded documents in the report", () => {
    const content = toReportContent(input);
    expect(content).toMatchObject({ title: "Uploaded documents", caseId: null, source: "Uploaded documents" });
    const definition = buildReportDocument(input);
    expect(definition.info.title).toBe("AuditFlow report – Uploaded documents");
    const text = reportText(definition);
    expect(text).toMatch(/Case\nNot applicable \(uploaded documents\)/);
    expect(text).toMatch(/Source\nUploaded documents/);
    expect(text).not.toMatch(/922486|Sample case/);
  });

  it("keep their uploaded files, document IDs, company and finding", () => {
    const content = toReportContent(input);
    expect(content.companyName).toBe(COMPANY);
    expect(content.documents).toEqual(UPLOADED.map((name) => ({ name, documentIds: [name.replace(/\.pdf$/, "")] })));
    expect(content.findings).toEqual(toReportContent({ ...input, workpaper: CASE_14 }).findings);
  });

  it("are named Uploaded-documents, while a sample case keeps its case name", () => {
    expect(reportPdfFileNameFor(workpaper, COMPLETED_AT)).toBe("AuditFlow_Report_Uploaded-documents_2026-10-25_090507.pdf");
    expect(reportPdfFileNameFor(CASE_14, COMPLETED_AT)).toBe("AuditFlow_Report_Case-14_2026-10-25_090507.pdf");
    expect(reportPdfFileNameFor({ ...CASE_14, case_id: "UPLOADED_1761380000000" }, COMPLETED_AT)).toBe(
      "AuditFlow_Report_Uploaded-documents_2026-10-25_090507.pdf",
    );
  });

  it("still list a sample case as that case", () => {
    expect(toReportContent({ workpaper: CASE_14, completedAt: COMPLETED_AT, sourceDocuments: CASE_14_FILES })).toMatchObject({
      title: "Case 14",
      caseId: "CASE_14",
      source: "Sample case (Case 14)",
    });
  });
});
