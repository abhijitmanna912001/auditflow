import type { ReactNode } from "react";
import type { Workpaper, WorkpaperRow } from "../types/workpaper";
import {
  actionLabel,
  caseDisplayName,
  resolverSummary,
} from "../lib/display-labels";

interface PrintReportProps {
  readonly workpaper: Workpaper;
  readonly completedAt: Date;
  readonly uploadedFileCount: number;
}

interface NumberedFinding {
  readonly label: string;
  readonly row: WorkpaperRow;
}

const formatDateTime = (date: Date) =>
  date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Print-only report built from the completed result already on the page.
 * Hidden on screen; shown by the print stylesheet when the user saves a PDF.
 * "Finding 01", "Finding 02", ... are a display sequence for this report
 * only, not stable finding IDs.
 */
export function PrintReport({
  workpaper,
  completedAt,
  uploadedFileCount,
}: PrintReportProps) {
  const findings: NumberedFinding[] = workpaper.rows
    .filter((row) => row.action === "human_review")
    .map((row, index) => ({
      label: `Finding ${String(index + 1).padStart(2, "0")}`,
      row,
    }));
  const [firstFinding, ...otherFindings] = findings;
  const findingByDocument = new Map(
    findings.map((finding) => [finding.row.document, finding.label]),
  );

  const references = new Map<string, string[]>();
  for (const row of workpaper.rows) {
    const usedFor =
      findingByDocument.get(row.document) ?? `${row.document} (no findings)`;
    for (const document of row.evidence) {
      references.set(document, [...(references.get(document) ?? []), usedFor]);
    }
  }
  const isUpload = uploadedFileCount > 0;
  const source = isUpload
    ? "Uploaded documents"
    : `Sample case (${caseDisplayName(workpaper.case_id)})`;

  return (
    <article className="print-report">
      <header className="report-header">
        <p>AuditFlow</p>
        <h2>Document review report</h2>
        <span>
          {source} · {formatDateTime(completedAt)}
        </span>
      </header>

      <section>
        <h3>1. Run summary</h3>
        <dl className="report-facts">
          <ReportFact label="Completed" value={formatDateTime(completedAt)} />
          <ReportFact label="Reference" value={workpaper.case_id} />
          <ReportFact label="Source" value={source} />
          {isUpload && (
            <ReportFact label="Files uploaded" value={uploadedFileCount} />
          )}
          <ReportFact
            label="Documents referenced in results"
            value={references.size}
          />
          <ReportFact
            label="Items checked"
            value={workpaper.summary.items_reviewed}
          />
          <ReportFact label="Items with findings" value={findings.length} />
          <ReportFact
            label="Items sent for review"
            value={workpaper.summary.human_review}
          />
          {workpaper.evidence_resolution && (
            <ReportFact
              label="Double-check"
              value={resolverSummary(workpaper.evidence_resolution)}
            />
          )}
        </dl>
        <p className="report-note">
          Review rule: any finding is sent for review. Items with no findings
          can be cleared. Confidence does not determine routing.
        </p>
      </section>

      <section>
        <h3>2. Findings summary</h3>
        {findings.length === 0 ? (
          <p>No findings were identified. All items can be cleared.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Finding</th>
                <th>Issue</th>
                <th>Document</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {findings.map(({ label, row }) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{row.finding}</td>
                  <td>{row.document}</td>
                  <td>{actionLabel(row.action)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        {/* Heading, intro and first finding print as one unbreakable block,
            so the heading is never left alone at the bottom of a page. */}
        <div className="report-keep">
          <h3>3. Detailed findings</h3>
          {firstFinding ? (
            <p className="report-note">
              Each finding shows what this result contains: the issue
              identified, the main document and the documents involved. Check
              amounts, dates and other values in the source documents.
            </p>
          ) : (
            <p>There are no findings to detail.</p>
          )}
          {firstFinding && <FindingBlock finding={firstFinding} />}
        </div>
        {otherFindings.map((finding) => (
          <FindingBlock key={finding.label} finding={finding} />
        ))}
      </section>

      <section>
        <h3>4. Documents involved and evidence references</h3>
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Referenced in</th>
            </tr>
          </thead>
          <tbody>
            {Array.from(references, ([document, usedFor]) => (
              <tr key={document}>
                <td>{document}</td>
                <td>{usedFor.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="report-scope">
        <h3>5. Scope of this report</h3>
        <p>
          AuditFlow compares invoices, purchase orders, receipts and payment
          records and lists document-level mismatches and missing documents for
          a person to review. It does not determine fraud or non-compliance,
          and its results are not an audit opinion. Every finding should be
          reviewed and resolved by a qualified person.
        </p>
        <p className="report-note">
          This report was created in your browser from the results on screen.
          AuditFlow does not store it.
        </p>
      </section>
    </article>
  );
}

interface FindingBlockProps {
  readonly finding: NumberedFinding;
}

function FindingBlock({ finding }: FindingBlockProps) {
  const { label, row } = finding;
  return (
    <div className="report-finding">
      <h4>
        {label} · {row.finding}
      </h4>
      <dl className="report-facts">
        <ReportFact label="What was identified" value={row.finding} />
        <ReportFact label="Document" value={row.document} />
        <ReportFact label="Result" value={actionLabel(row.action)} />
        <ReportFact
          label="Documents involved"
          value={row.evidence.join(", ")}
        />
      </dl>
    </div>
  );
}

interface ReportFactProps {
  readonly label: string;
  readonly value: ReactNode;
}

function ReportFact({ label, value }: ReportFactProps) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
