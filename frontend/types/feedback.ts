import type { Action } from "./workpaper";

/** Reviewer's verdict on a single finding, tied to the agent's original action. */
export type FeedbackDecision = "confirmed" | "overturned" | "evidence_requested";

/**
 * One reviewer decision event, capturing the signal for later analysis
 * (no retraining loop yet — this is the persisted record of what a human
 * decided, and what the agent had decided first).
 */
export interface FeedbackRecord {
  case_id: string;
  document: string;
  finding: string;
  agent_action: Action;
  decision: FeedbackDecision;
  note?: string;
  timestamp: string; // ISO 8601, set client-side at the moment of decision
}
