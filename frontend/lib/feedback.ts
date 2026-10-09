import type { FeedbackRecord } from "../types/feedback";

import { apiFetch } from "./api-client";

export type FeedbackHistoryResult =
  | { readonly kind: "ok"; readonly records: FeedbackRecord[] }
  | { readonly kind: "needs_code" }
  | { readonly kind: "unavailable" };

/**
 * Persists a single reviewer decision. Expects a backend route at
 * POST /feedback accepting the FeedbackRecord shape as JSON.
 * Fails silently (returns false) so the caller can keep the decision in
 * local state even when the persistence API isn't reachable yet — same
 * fail-open pattern as fetchWorkpaper / fetchWorkpaperFromUpload.
 */
export async function persistFeedback(record: FeedbackRecord): Promise<boolean> {
  try {
    const resp = await apiFetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Fetches every persisted feedback record for the history dashboard.
 * Expects GET /feedback/history returning FeedbackRecord[].
 * "unavailable" (not an empty list) on failure so the caller can tell
 * "no history yet" apart from "backend unreachable"; "needs_code" when the
 * backend asks for an access code.
 */
export async function fetchFeedbackHistory(): Promise<FeedbackHistoryResult> {
  try {
    const resp = await apiFetch("/feedback/history");
    if (resp.status === 401) return { kind: "needs_code" };
    if (!resp.ok) return { kind: "unavailable" };
    const data = await resp.json();
    return Array.isArray(data)
      ? { kind: "ok", records: data as FeedbackRecord[] }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
