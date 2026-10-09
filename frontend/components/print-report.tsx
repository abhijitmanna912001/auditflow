import type { ReactNode } from "react";
import type {
  FindingDetail,
  Workpaper,
  WorkpaperRow,
} from "../types/workpaper";
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

interface ReportEntry {
  readonly finding: FindingDetail;
  readonly result: string;
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

  // When the response carries per-finding detail, list one entry per finding.
  // Otherwise fall back to the row-based output.
  const entries: ReportEntry[] = (workpaper.findings ?? []).map((finding) => {
    const row = workpaper.rows.find(
      (candidate) => candidate.document === finding.row_document,
    );
    return {
      finding,
      result: actionLabel(row ? row.action : "human_review"),
    };
  });
  const [firstEntry, ...otherEntries] = entries;
  const useEntries = entries.length > 0;
  const entryIdsByDocument = new Map<string, string[]>();
  for (const { finding } of entries) {
    const ids = entryIdsByDocument.get(finding.row_document) ?? [];
    entryIdsByDocument.set(finding.row_document, [...ids, finding.finding_id]);
  }

  const references = new Map<string, string[]>();
  const addReference = (document: string, usedFor: string) => {
    const current = references.get(document) ?? [];
    if (!current.includes(usedFor)) {
      references.set(document, [...current, usedFor]);
    }
  };
  for (const row of workpaper.rows) {
    const noFindings = `${row.document} (no findings)`;
    const rowLabels = [findingByDocument.get(row.document) ?? noFindings];
    const entryLabels = entryIdsByDocument.get(row.document) ?? [noFindings];
    const usedFor = useEntries ? entryLabels : rowLabels;
    for (const document of row.evidence) {
      for (const label of usedFor) addReference(document, label);
    }
  }
  for (const { finding } of entries) {
    for (const document of finding.documents) {
      addReference(document, finding.finding_id);
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
          {!isUpload && (
            <ReportFact label="Reference" value={workpaper.case_id} />
          )}
          <ReportFact label="Source" value={source} />
          {isUpload && (
            <ReportFact label="Files uploaded" value={uploadedFileCount} />
          )}
          <ReportFact
            label="Documents referenced in results"
            value={references.size}
          />
          <ReportFact
            label="Transactions checked"
            value={workpaper.summary.items_reviewed}
          />
          <ReportFact label="Items with findings" value={findings.length} />
          <ReportFact
            label="Items needing review"
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
          Review rule: any finding needs review. Items with no findings
          can be cleared. Confidence does not determine routing.
        </p>
      </section>

      <section>
        <h3>2. Findings summary</h3>
        {useEntries && (
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Issue</th>
                <th>Document</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(({ finding, result }) => (
                <tr key={finding.finding_id}>
                  <td>{finding.finding_id}</td>
                  <td>{finding.label}</td>
                  <td>{finding.primary_document}</td>
                  <td>{result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!useEntries && findings.length === 0 && (
          <p>No findings were identified. All items can be cleared.</p>
        )}
        {!useEntries && findings.length > 0 && (
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
          {(useEntries || firstFinding) ? (
            <p className="report-note">
              Each finding shows what this result contains: the issue
              identified, the main document and the documents involved. Check
              amounts, dates and other values in the source documents.
            </p>
          ) : (
            <p>There are no findings to detail.</p>
          )}
          {useEntries && firstEntry && <EntryBlock entry={firstEntry} />}
          {!useEntries && firstFinding && (
            <FindingBlock finding={firstFinding} />
          )}
        </div>
        {useEntries &&
          otherEntries.map((entry) => (
            <EntryBlock key={entry.finding.finding_id} entry={entry} />
          ))}
        {!useEntries &&
          otherFindings.map((finding) => (
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
          AuditFlow does not keep a copy of this report.
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

interface EntryBlockProps {
  readonly entry: ReportEntry;
}

function EntryBlock({ entry }: EntryBlockProps) {
  const { finding, result } = entry;
  return (
    <div className="report-finding">
      <h4>
        {finding.finding_id} · {finding.label}
      </h4>
      <dl className="report-facts">
        <ReportFact label="What was identified" value={finding.label} />
        <ReportFact label="Why it was flagged" value={finding.explanation} />
        <ReportFact label="Document" value={finding.primary_document} />
        <ReportFact
          label="Related documents"
          value={finding.documents.length > 0 ? finding.documents.join(", ") : "None listed"}
        />
        <ReportFact label="Result" value={result} />
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
