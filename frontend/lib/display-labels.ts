import type { Action, EvidenceResolution } from "../types/workpaper";

/**
 * Display-only labels. The raw values (case IDs, action codes, the "Clean"
 * finding label) stay unchanged in data, API calls and feedback records.
 */

export function caseDisplayName(caseId: string): string {
  if (caseId.startsWith("UPLOADED")) return "Uploaded documents";
  const match = /^CASE_(\d+)$/.exec(caseId);
  return match ? `Case ${match[1]}` : caseId;
}

export const actionLabel = (action: Action) =>
  action === "auto_clear" ? "Can be cleared" : "Needs review";

export const findingLabel = (finding: string) =>
  finding === "Clean" ? "No findings" : finding;

export function resolverSummary(resolution: EvidenceResolution) {
  if (!resolution.second_pass_run)
    return `Not double-checked — ${resolution.reason}`;
  const verdict = resolution.agreement
    ? "Both checks agreed"
    : "The two checks disagreed. Documents missing in either check are listed";
  return `${verdict}. ${resolution.reason}`;
}
