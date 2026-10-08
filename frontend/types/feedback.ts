import type { Action } from "./workpaper";

/** Ticket-style outcome a reviewer records on a single finding. */
export type FeedbackDecision = "discarded" | "assigned" | "closed";

/** Earlier decision values; still readable in saved records, no longer offered. */
export type LegacyFeedbackDecision = "confirmed" | "overturned" | "evidence_requested";

/** Any decision value that can appear in a saved record. */
export type StoredFeedbackDecision = FeedbackDecision | LegacyFeedbackDecision;

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
  decision: StoredFeedbackDecision;
  note?: string;
  assignee?: string; // set only when decision is "assigned"
  timestamp: string; // ISO 8601, set client-side at the moment of decision
}
