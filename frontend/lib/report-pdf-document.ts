import type {
  DocumentMapEntry,
  FindingDetail,
  Workpaper,
  WorkpaperRow,
} from "../types/workpaper";
import { actionLabel, caseDisplayName } from "./display-labels";

/**
 * Builds the content and layout of the PDF report from a completed result.
 * Pure data in, pdfmake document definition out: nothing here loads the PDF
 * library, makes a request or calls a model (see report-pdf.ts for that).
 *
 * The report deliberately leaves out severity (and the summary's `critical`
 * count, which is a severity count), anything about access or sign-in, and
 * the contents of the documents: it names documents, it never embeds them.
 */

/** The completed result the report is made from. */
export interface ReportPdfInput {
  readonly workpaper: Workpaper;
  /** When the run completed, in the browser's local time zone. */
  readonly completedAt: Date;
  /** Optional. A missing or blank name prints as "Not provided". */
  readonly companyName?: string | null;
}

/** The report data is missing something the report needs, or is malformed. */
export class ReportPdfDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportPdfDataError";
  }
}

export const CONFIDENCE_NOTE = "Confidence is for reference.";

export interface ReportDocument {
  /** File name for uploaded documents, otherwise the document ID. */
  readonly name: string;
  /** Upload runs only: the document IDs read from this file. */
  readonly documentIds: readonly string[];
}

export interface ReportFinding {
  readonly reference: string;
  readonly label: string;
  readonly explanation: string;
  readonly mainDocument: string;
  /** The documents the finding cites. */
  readonly relatedDocuments: readonly string[];
  /** 0–1, as in the data layer. */
  readonly confidence: number;
  readonly result: string;
}

/** Everything the report shows, already checked. */
export interface ReportContent {
  readonly companyName: string | null;
  readonly reportDate: string;
  /** "Case 14", or "Uploaded documents" for an upload run. */
  readonly title: string;
  /** Sample cases only, e.g. "CASE_14". An upload run has no case ID. */
  readonly caseId: string | null;
  readonly source: string;
  readonly itemsReviewed: number;
  readonly itemsNeedingReview: number;
  readonly itemsCleared: number;
  readonly documents: readonly ReportDocument[];
  readonly findings: readonly ReportFinding[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Local date and time with the UTC offset, for example
 * "25 October 2026, 13:45:07 (UTC+05:30)". Local, so it matches the time the
 * user saw on screen; the offset makes it unambiguous for anyone else.
 */
export function formatReportDate(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const offsetText = `${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(":");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${time} (UTC${sign}${offsetText})`;
}

export const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReportPdfDataError(`The report data is missing ${what}.`);
  }
  return value;
}

function requireCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ReportPdfDataError(`The report data has an invalid ${what}.`);
  }
  return value;
}

function requireStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ReportPdfDataError(`The report data has an invalid ${what}.`);
  }
  return value;
}

/** Trimmed, non-empty strings in first-seen order, without repeats. */
function unique(values: readonly unknown[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = singleLine(value);
    if (text && !seen.includes(text)) seen.push(text);
  }
  return seen;
}

function checkRow(row: unknown, index: number): WorkpaperRow {
  const what = `row ${index + 1}`;
  if (!isObject(row)) throw new ReportPdfDataError(`The report data has an invalid ${what}.`);
  if (row.action !== "auto_clear" && row.action !== "human_review") {
    throw new ReportPdfDataError(`The report data has no valid result for ${what}.`);
  }
  requireStrings(row.evidence, `document list for ${what}`);
  return row as unknown as WorkpaperRow;
}

function checkFinding(finding: unknown, index: number): FindingDetail {
  const what = `finding ${index + 1}`;
  if (!isObject(finding)) throw new ReportPdfDataError(`The report data has an invalid ${what}.`);
  requireText(finding.finding_id, `the reference for ${what}`);
  requireText(finding.label, `the label for ${what}`);
  requireText(finding.explanation, `the explanation for ${what}`);
  requireText(finding.primary_document, `the main document for ${what}`);
  requireStrings(finding.documents, `related document list for ${what}`);
  if (
    typeof finding.confidence !== "number" ||
    !(finding.confidence >= 0 && finding.confidence <= 1)
  ) {
    throw new ReportPdfDataError(`The report data has an invalid confidence for ${what}.`);
  }
  return finding as unknown as FindingDetail;
}

/**
 * Upload runs list each uploaded file with the document IDs read from it.
 * Sample cases have no file list in the result, so they list the document
 * IDs the result references.
 */
function reportDocuments(
  workpaper: Workpaper,
  rows: readonly WorkpaperRow[],
  findings: readonly FindingDetail[],
): ReportDocument[] {
  const referenced = unique([
    ...rows.flatMap((row) => [row.document, ...row.evidence]),
    ...findings.flatMap((finding) => [
      finding.primary_document,
      ...finding.documents,
      ...(Array.isArray(finding.transaction_documents) ? finding.transaction_documents : []),
    ]),
  ]);
  const map = (Array.isArray(workpaper.documents) ? workpaper.documents : []).filter(
    (entry): entry is DocumentMapEntry =>
      isObject(entry) && typeof entry.doc_id === "string" && typeof entry.source_file === "string",
  );
  const files = unique([
    ...(Array.isArray(workpaper.uploaded_files) ? workpaper.uploaded_files : []),
    ...map.map((entry) => entry.source_file),
  ]);
  if (files.length === 0) {
    return referenced.map((name) => ({ name, documentIds: [] }));
  }

  const mapped = new Set(map.map((entry) => singleLine(entry.doc_id)));
  return [
    ...files.map((name) => ({
      name,
      documentIds: unique(
        map.filter((entry) => singleLine(entry.source_file) === name).map((entry) => entry.doc_id),
      ),
    })),
    ...referenced
      .filter((id) => !mapped.has(id))
      .map((name) => ({ name, documentIds: [] })),
  ];
}

/** Checks the completed result and picks out what the report shows. */
export function toReportContent(input: ReportPdfInput): ReportContent {
  const { workpaper, completedAt, companyName } = (input ?? {}) as Partial<ReportPdfInput>;
  if (!isObject(workpaper)) {
    throw new ReportPdfDataError("There is no completed result to make a report from.");
  }
  if (!isValidDate(completedAt)) {
    throw new ReportPdfDataError("The report date is missing or invalid.");
  }
  const caseId = singleLine(requireText(workpaper.case_id, "the case identifier"));
  if (!Array.isArray(workpaper.rows)) {
    throw new ReportPdfDataError("The report data has no result rows.");
  }
  if (!isObject(workpaper.summary)) {
    throw new ReportPdfDataError("The report data has no summary.");
  }
  if (workpaper.findings !== undefined && !Array.isArray(workpaper.findings)) {
    throw new ReportPdfDataError("The report data has an invalid findings list.");
  }

  const rows = workpaper.rows.map(checkRow);
  const findings = (workpaper.findings ?? []).map(checkFinding);
  // Every finding must be explained, so a result that only has row labels
  // (no finding details) can't be reported.
  if (rows.some((row) => row.action === "human_review") && findings.length === 0) {
    throw new ReportPdfDataError(
      "The report data has items that need review but no finding details to explain them.",
    );
  }

  const isUpload = caseId.startsWith("UPLOADED");
  const title = caseDisplayName(caseId);
  const company = typeof companyName === "string" ? singleLine(companyName) : "";

  return {
    companyName: company || null,
    reportDate: formatReportDate(completedAt),
    title,
    caseId: isUpload ? null : caseId,
    source: isUpload ? "Uploaded documents" : `Sample case (${title})`,
    itemsReviewed: requireCount(workpaper.summary.items_reviewed, "count of items reviewed"),
    itemsNeedingReview: requireCount(workpaper.summary.human_review, "count of items needing review"),
    itemsCleared: requireCount(workpaper.summary.auto_cleared, "count of items cleared"),
    documents: reportDocuments(workpaper, rows, findings),
    findings: findings.map((finding) => {
      const row = rows.find((candidate) => candidate.document === finding.row_document);
      return {
        reference: singleLine(finding.finding_id),
        label: singleLine(finding.label),
        explanation: finding.explanation.trim(),
        mainDocument: singleLine(finding.primary_document),
        relatedDocuments: unique(finding.documents),
        confidence: finding.confidence,
        result: actionLabel(row ? row.action : "human_review"),
      };
    }),
  };
}

/** A pdfmake content node. Loosely typed: pdfmake checks the shape. */
export type PdfContent = string | { readonly [key: string]: unknown } | readonly PdfContent[];

interface PdfNodeInfo {
  readonly headlineLevel?: number;
}

/** The parts of a pdfmake document definition this report uses. */
export interface PdfDocumentDefinition {
  readonly pageSize: "A4";
  readonly pageMargins: readonly [number, number, number, number];
  readonly info: Readonly<Record<string, string>>;
  readonly content: readonly PdfContent[];
  readonly footer: (currentPage: number, pageCount: number) => PdfContent;
  readonly pageBreakBefore: (
    node: PdfNodeInfo,
    nodes: { getFollowingNodesOnPage(): readonly unknown[] },
  ) => boolean;
  readonly styles: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly defaultStyle: Readonly<Record<string, unknown>>;
}

export const ZERO_WIDTH_SPACE = "​";

/**
 * Words longer than `longest` characters (long file names, IDs) get an
 * invisible break point every `longest` characters, so a line can wrap
 * inside them instead of running past the cell or the margin. Roboto has a
 * zero-width glyph for U+200B, so nothing visible is added. The default
 * fits the report's widest columns; shorter words are left alone so they
 * stay searchable in a PDF viewer.
 */
export function wrapLongWords(text: string, longest = 40): string {
  const longWord = new RegExp(`\\S{${longest + 1},}`, "gu");
  const part = new RegExp(`\\S{1,${longest}}`, "gu");
  return text.replace(longWord, (word) => (word.match(part) ?? [word]).join(ZERO_WIDTH_SPACE));
}

const COLOR = {
  ink: "#1f2933",
  muted: "#5b6573",
  rule: "#d7dde3",
  band: "#f2f4f7",
};

const tableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => COLOR.rule,
  paddingLeft: () => 6,
  paddingRight: () => 6,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

const heading = (text: string): PdfContent => ({ text, style: "heading", headlineLevel: 1 });

function factsTable(facts: ReadonlyArray<readonly [string, string]>): PdfContent {
  return {
    table: {
      widths: [128, "*"],
      body: facts.map(([label, value]) => [
        { text: label, style: "factLabel" },
        { text: wrapLongWords(value) },
      ]),
    },
    layout: tableLayout,
    margin: [0, 0, 0, 4],
  };
}

function documentsTable(documents: readonly ReportDocument[]): PdfContent {
  if (documents.length === 0) {
    return { text: "No documents are listed in this result.", style: "body" };
  }
  const isUpload = documents.some((document) => document.documentIds.length > 0);
  const header = isUpload ? ["#", "File", "Read as"] : ["#", "Document"];
  return {
    table: {
      headerRows: 1,
      widths: isUpload ? [22, "*", 150] : [22, "*"],
      body: [
        header.map((text) => ({ text, style: "tableHeader" })),
        ...documents.map((document, index) => [
          { text: String(index + 1), color: COLOR.muted },
          { text: wrapLongWords(document.name) },
          ...(isUpload
            ? [{ text: wrapLongWords(document.documentIds.join(", ") || "Not linked to a document", 20) }]
            : []),
        ]),
      ],
    },
    layout: { ...tableLayout, fillColor: (row: number) => (row === 0 ? COLOR.band : null) },
  };
}

function findingBlock(finding: ReportFinding, index: number, count: number): PdfContent {
  return [
    {
      text: `Finding ${index + 1} of ${count}: ${wrapLongWords(finding.label)}`,
      style: "findingTitle",
      headlineLevel: 2,
    },
    factsTable([
      ["Reference", finding.reference],
      ["Explanation", finding.explanation],
      ["Main document", finding.mainDocument],
      [
        "Related documents",
        finding.relatedDocuments.length > 0 ? finding.relatedDocuments.join(", ") : "None listed",
      ],
      ["Confidence", `${Math.round(finding.confidence * 100)}%`],
      ["Result", finding.result],
    ]),
  ];
}

/** Lays out the report as a pdfmake document definition. */
export function layoutReport(content: ReportContent): PdfDocumentDefinition {
  const caseText = content.caseId
    ? `${content.title} (${content.caseId})`
    : "Not applicable (uploaded documents)";
  return {
    pageSize: "A4",
    // Left, top, right, bottom, in points (72 per inch).
    pageMargins: [56, 56, 56, 64],
    info: {
      title: `AuditFlow report – ${content.title}`,
      author: "AuditFlow",
      subject: "Document review report",
      creator: "AuditFlow",
    },
    content: [
      { text: "AUDITFLOW", style: "brand" },
      { text: "Document review report", style: "title" },
      { text: `${content.title} · ${content.reportDate}`, style: "subtitle" },
      factsTable([
        ["Company", content.companyName ?? "Not provided"],
        ["Report date", content.reportDate],
        ["Case", caseText],
        ["Source", content.source],
        ["Transactions checked", String(content.itemsReviewed)],
        ["Items needing review", String(content.itemsNeedingReview)],
        ["Items that can be cleared", String(content.itemsCleared)],
      ]),
      { text: "Review rule: any finding needs review. Items with no findings can be cleared.", style: "note" },

      heading("Documents"),
      documentsTable(content.documents),

      heading("Findings"),
      { text: CONFIDENCE_NOTE, style: "note" },
      ...(content.findings.length > 0
        ? content.findings.map((finding, index) =>
            findingBlock(finding, index, content.findings.length),
          )
        : [{ text: "No findings were identified. All items can be cleared.", style: "body" }]),

      {
        // Short and kept on one page, so no line of it is left on its own.
        unbreakable: true,
        stack: [
          heading("Scope of this report"),
          {
            text:
              "AuditFlow compares invoices, purchase orders, receipts and payment records and lists " +
              "document-level mismatches and missing documents for a person to review. It does not " +
              "determine fraud or non-compliance, and its results are not an audit opinion. Every " +
              "finding should be reviewed and resolved by a qualified person.",
            style: "body",
          },
          {
            text:
              "This report was created in your browser from the completed result. It names the " +
              "documents but does not include them. AuditFlow does not keep a copy of this report.",
            style: "note",
          },
        ],
      },
    ],
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: `AuditFlow · ${content.title} · ${content.reportDate}` },
        { text: `Page ${currentPage} of ${pageCount}`, alignment: "right", width: 80 },
      ],
      margin: [56, 24, 56, 0],
      style: "footer",
    }),
    // Keep headings with what follows: a heading that would end a page
    // starts the next one instead.
    pageBreakBefore: (node, nodes) =>
      node.headlineLevel !== undefined && nodes.getFollowingNodesOnPage().length === 0,
    styles: {
      brand: { fontSize: 9, bold: true, color: COLOR.muted },
      title: { fontSize: 20, bold: true, margin: [0, 2, 0, 2] },
      subtitle: { fontSize: 10, color: COLOR.muted, margin: [0, 0, 0, 14] },
      heading: { fontSize: 13, bold: true, margin: [0, 16, 0, 6] },
      findingTitle: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
      factLabel: { bold: true, color: COLOR.muted },
      tableHeader: { bold: true },
      body: { margin: [0, 0, 0, 6] },
      note: { fontSize: 9, italics: true, color: COLOR.muted, margin: [0, 2, 0, 6] },
      footer: { fontSize: 8, color: COLOR.muted },
    },
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.25, color: COLOR.ink },
  };
}

/** Checks the result and lays out its report in one step. */
export const buildReportDocument = (input: ReportPdfInput) => layoutReport(toReportContent(input));
