/** A decision emitted by the Workpaper Agent. */
export type Action = "auto_clear" | "human_review";

/**
 * Confidence is always kept as a 0–1 value in the data layer. Convert it to a
 * percentage only at presentation boundaries.
 */
declare const confidenceBrand: unique symbol;
export type Confidence = number & { readonly [confidenceBrand]: "Confidence" };

export function confidence(value: number): Confidence {
  if (value < 0 || value > 1) {
    throw new RangeError("Confidence must be a value from 0 to 1.");
  }

  return value as Confidence;
}

/** Plain-language Workpaper finding, for example “Clean” or “Amount mismatch”. */
export type Finding = string;

/** The document IDs that support a Workpaper finding. */
export type Evidence = string[];

/** Exact row shape produced by the Workpaper Agent. */
export interface WorkpaperRow {
  document: string;
  finding: Finding;
  evidence: Evidence;
  confidence: Confidence;
  action: Action;
}

/** Exact summary shape produced by the Workpaper Agent. */
export interface Summary {
  items_reviewed: number;
  auto_cleared: number;
  human_review: number;
  critical: number;
  assumed_minutes_per_item: number;
  estimated_minutes_saved: number;
}

/**
 * Record of the Evidence Resolver's second-pass run, surfaced at the top level
 * of the workpaper (not per-row) by the backend when use_resolver is enabled.
 * The pass_*_missing_evidence fields are present only on a disagreement.
 */
export interface EvidenceResolution {
  second_pass_run: boolean;
  agreement: boolean | null;
  reason: string;
  pass_1_missing_evidence?: string[];
  pass_2_missing_evidence?: string[];
}

/** Exact top-level Workpaper Agent payload rendered by the frontend. */
export interface Workpaper {
  case_id: string;
  rows: WorkpaperRow[];
  summary: Summary;
  evidence_resolution?: EvidenceResolution | null;
}
