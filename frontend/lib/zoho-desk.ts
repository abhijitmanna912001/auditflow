import type {
  DocumentMapEntry,
  FindingDetail,
  Workpaper,
} from "../types/workpaper";
import { apiFetch, friendlyApiError } from "./api-client";

// Sends one finding at a time to POST /send-to-zoho-desk. The access code is
// handled by apiFetch; nothing here reads, logs or shows it.

const REQUEST_TIMEOUT_MS = 90_000;

const NETWORK_MESSAGE =
  "Couldn't confirm. Some tickets may have been created. Sending again is safe; existing ones are skipped.";
const UNCONFIRMED_MESSAGE =
  "Couldn't confirm whether this finding is already in Zoho Desk, so nothing was sent. Try again.";
const ZOHO_FAILED_MESSAGE = "Zoho Desk couldn't be reached. Try again.";
const GENERIC_MESSAGE =
  "Something went wrong sending this finding. Try again.";

export type SendStatus =
  | { readonly state: "sending" }
  | {
      readonly state: "created" | "duplicate";
      readonly ticketNumber: string | null;
      readonly webUrl: string | null;
      readonly notes: readonly string[];
    }
  | { readonly state: "unconfirmed"; readonly message: string }
  | { readonly state: "failed"; readonly message: string };

export interface SendOutcome {
  readonly status: Exclude<SendStatus, { readonly state: "sending" }>;
  // True when the rest of a "send all" run should not be attempted.
  readonly stop: boolean;
}

export interface SendFindingArgs {
  readonly company: string;
  readonly finding: FindingDetail;
  readonly workpaper: Workpaper;
  readonly uploadedFiles: readonly File[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapEntries(workpaper: Workpaper): DocumentMapEntry[] {
  return Array.isArray(workpaper.documents) ? [...workpaper.documents] : [];
}

// The finding's own documents, or the whole transaction when it cites none.
export function findingDocumentIds(finding: FindingDetail): string[] {
  const own = stringList(finding.documents);
  return own.length > 0 ? own : stringList(finding.transaction_documents);
}

// Distinct source files behind those documents, in first-seen order.
export function findingSourceFiles(
  finding: FindingDetail,
  workpaper: Workpaper,
): string[] {
  const ids = new Set(findingDocumentIds(finding));
  const names: string[] = [];
  mapEntries(workpaper).forEach((entry) => {
    if (ids.has(entry.doc_id) && !names.includes(entry.source_file)) {
      names.push(entry.source_file);
    }
  });
  return names;
}

export function buildTicketForm({
  company,
  finding,
  workpaper,
  uploadedFiles,
}: SendFindingArgs): FormData {
  const form = new FormData();
  form.append("company", company);
  form.append(
    "finding",
    JSON.stringify({
      finding_id: finding.finding_id,
      type: finding.type,
      label: finding.label,
      explanation: finding.explanation,
      primary_document: finding.primary_document,
      documents: stringList(finding.documents),
      transaction_documents: stringList(finding.transaction_documents),
    }),
  );
  form.append("documents_map", JSON.stringify(mapEntries(workpaper)));
  form.append(
    "ambiguous_doc_ids",
    JSON.stringify(stringList(workpaper.ambiguous_doc_ids)),
  );
  const sentNames = stringList(workpaper.uploaded_files);
  findingSourceFiles(finding, workpaper).forEach((name) => {
    const file = uploadedFiles[sentNames.indexOf(name)];
    // No Content-Type is set anywhere: the browser adds the multipart boundary.
    if (file) form.append("files", file, name);
  });
  return form;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function attachmentNotes(
  ticketNumber: string | null,
  attachments: unknown,
): string[] {
  const data = (attachments ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  const failed = stringList(data.failed).length;
  const tooLarge = stringList(data.not_attached_size).length;
  if (failed > 0) {
    const label = ticketNumber ? `Ticket #${ticketNumber}` : "The ticket";
    notes.push(
      `${label} created, but ${failed} ${plural(failed, "file", "files")} couldn't be attached.`,
    );
  }
  if (tooLarge > 0) {
    notes.push(
      `${tooLarge} ${plural(tooLarge, "file was", "files were")} too large and ${plural(tooLarge, "is", "are")} listed in the ticket.`,
    );
  }
  return notes;
}

// Only http(s) links are ever rendered as links.
export function safeTicketUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function readBodyDetail(resp: Response): Promise<string | null> {
  try {
    const body = await resp.json();
    return typeof body?.detail === "string" && body.detail.trim() !== ""
      ? body.detail
      : null;
  } catch {
    return null;
  }
}

async function failureMessage(resp: Response): Promise<string> {
  if (resp.status === 429 || resp.status === 503) {
    const detail = await readBodyDetail(resp);
    if (detail) return detail;
    return (await friendlyApiError(resp)) ?? GENERIC_MESSAGE;
  }
  if (resp.status === 502) return ZOHO_FAILED_MESSAGE;
  const friendly = await friendlyApiError(resp);
  return friendly ?? GENERIC_MESSAGE;
}

const STOP_STATUSES = [401, 403, 429, 503];

export async function sendFinding(args: SendFindingArgs): Promise<SendOutcome> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await apiFetch("/send-to-zoho-desk", {
      method: "POST",
      body: buildTicketForm(args),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        status: { state: "failed", message: await failureMessage(resp) },
        stop: STOP_STATUSES.includes(resp.status),
      };
    }
    const data = await resp.json();
    if (data?.outcome === "unconfirmed") {
      return {
        status: { state: "unconfirmed", message: UNCONFIRMED_MESSAGE },
        stop: false,
      };
    }
    if (data?.outcome === "created" || data?.outcome === "duplicate") {
      const ticketNumber =
        data.ticket_number === null || data.ticket_number === undefined
          ? null
          : String(data.ticket_number);
      const notes =
        data.outcome === "created"
          ? attachmentNotes(ticketNumber, data.attachments)
          : [];
      return {
        status: {
          state: data.outcome,
          ticketNumber,
          webUrl: typeof data.web_url === "string" ? data.web_url : null,
          notes,
        },
        stop: false,
      };
    }
    return { status: { state: "failed", message: GENERIC_MESSAGE }, stop: false };
  } catch {
    // Network error or timeout: the ticket may or may not exist.
    return { status: { state: "failed", message: NETWORK_MESSAGE }, stop: false };
  } finally {
    window.clearTimeout(timer);
  }
}

function withoutFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

export function ticketLabel(status: SendStatus): string {
  if (status.state !== "created" && status.state !== "duplicate") return "";
  return status.ticketNumber ? `#${status.ticketNumber}` : "";
}

// One plain-language line for a finished run (one finding or many).
export function summarizeRun(
  company: string,
  statuses: readonly SendStatus[],
  total: number,
): string {
  const created = statuses.filter((item) => item.state === "created").length;
  const duplicates = statuses.filter((item) => item.state === "duplicate");
  const unconfirmed = statuses.filter((item) => item.state === "unconfirmed");
  const failures = statuses.flatMap((item) =>
    item.state === "failed" ? [item.message] : [],
  );
  const notAttempted = total - statuses.length;

  const allCreated =
    created === total && total > 0 && notAttempted === 0;
  if (allCreated) {
    return `${created} ${plural(created, "ticket", "tickets")} created in Zoho Desk for ${company}.`;
  }

  const parts = [`${created} of ${total} sent.`];
  if (duplicates.length > 0) {
    const numbers = duplicates.map(ticketLabel).filter((item) => item !== "");
    const where =
      numbers.length > 0
        ? ` (${plural(numbers.length, "ticket", "tickets")} ${numbers.join(", ")})`
        : "";
    parts.push(
      `${duplicates.length} ${plural(duplicates.length, "was", "were")} already in Zoho Desk${where}.`,
    );
  }
  if (unconfirmed.length > 0) parts.push(UNCONFIRMED_MESSAGE);
  if (failures.length > 0) {
    const reasons = Array.from(new Set(failures)).map(withoutFinalPeriod);
    parts.push(`${failures.length} failed: ${reasons.join("; ")}.`);
  }
  if (notAttempted > 0) parts.push("The remaining findings were not sent.");
  return parts.join(" ");
}

export function unmappedNotice(workpaper: Workpaper): string | null {
  const names = stringList(workpaper.unmapped_files);
  return names.length > 0
    ? `Not linked to any document: ${names.join(", ")}`
    : null;
}

export function ambiguousNotice(workpaper: Workpaper): string | null {
  const ids = stringList(workpaper.ambiguous_doc_ids);
  return ids.length > 0
    ? `Two files were read as the same document (${ids.join(", ")}); both are attached.`
    : null;
}
