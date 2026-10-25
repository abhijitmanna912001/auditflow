import { caseDisplayName } from "./display-labels";
import {
  buildReportDocument,
  isValidDate,
  ReportPdfDataError,
  type ReportPdfInput,
} from "./report-pdf-document";

export { ReportPdfDataError, type ReportPdfInput } from "./report-pdf-document";

type PdfMake = (typeof import("pdfmake/build/pdfmake"))["default"];

let pdfMakeLoad: Promise<PdfMake> | null = null;

/**
 * pdfmake and its Roboto fonts are large, so they are imported only here,
 * on first use. Keep it that way: a static import of pdfmake anywhere would
 * put them in the page's initial bundle.
 */
function loadPdfMake(): Promise<PdfMake> {
  pdfMakeLoad ??= Promise.all([
    import("pdfmake/build/pdfmake"),
    import("pdfmake/build/vfs_fonts"),
  ])
    .then(([{ default: pdfMake }, { default: vfs }]) => {
      pdfMake.addVirtualFileSystem(vfs);
      // The report has no images or links to load. Refusing every URL means
      // building it can never make a network request.
      pdfMake.setUrlAccessPolicy(() => false);
      return pdfMake;
    })
    .catch((error: unknown) => {
      pdfMakeLoad = null; // let a later attempt retry the import
      throw error;
    });
  return pdfMakeLoad;
}

/**
 * Creates the report PDF in the browser from the completed result and
 * returns its bytes, so one generated file can be both downloaded and
 * uploaded. Makes no backend request and no model call. Throws
 * ReportPdfDataError, before loading pdfmake, if the result can't be
 * reported.
 */
export async function generateReportPdf(input: ReportPdfInput): Promise<Uint8Array<ArrayBuffer>> {
  const definition = buildReportDocument(input);
  const pdfMake = await loadPdfMake();
  return new Uint8Array(await pdfMake.createPdf(definition).getBuffer());
}

/**
 * File name for a generated report:
 * AuditFlow_Report_<case-id>_<YYYY-MM-DD>_<HHmmss>.pdf.
 *
 * Time zone: the date and time are the browser's local time, the same clock
 * as the report date printed in the PDF (which also states the UTC offset)
 * and as the current Save PDF report file name.
 *
 * <case-id> is the case's display name with every run of characters other
 * than ASCII letters, digits and hyphens turned into one hyphen, so the name
 * is valid on Windows, macOS, Linux and Google Drive: "CASE_14" gives
 * "Case-14" and an upload run gives "Uploaded-documents". Only the case ID
 * and the time go into the name.
 */
export function reportPdfFileName(caseId: string, completedAt: Date): string {
  if (!isValidDate(completedAt)) {
    throw new ReportPdfDataError("The report date is missing or invalid.");
  }
  const caseName =
    caseDisplayName(typeof caseId === "string" ? caseId.trim() : "")
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "Unnamed-case";
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [completedAt.getFullYear(), pad(completedAt.getMonth() + 1), pad(completedAt.getDate())].join("-");
  const time = [completedAt.getHours(), completedAt.getMinutes(), completedAt.getSeconds()].map(pad).join("");
  return `AuditFlow_Report_${caseName}_${date}_${time}.pdf`;
}
