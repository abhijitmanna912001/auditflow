import type { FeedbackRecord } from "../types/feedback";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

/**
 * Persists a single reviewer decision. Expects a backend route at
 * POST /feedback accepting the FeedbackRecord shape as JSON.
 * Fails silently (returns false) so the caller can keep the decision in
 * local state even when the persistence API isn't reachable yet — same
 * fail-open pattern as fetchWorkpaper / fetchWorkpaperFromUpload.
 */
export async function persistFeedback(record: FeedbackRecord): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/feedback`, {
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
 * Returns null (not []) on failure so the caller can tell "no history yet"
 * apart from "backend unreachable" and render accordingly.
 */
export async function fetchFeedbackHistory(): Promise<FeedbackRecord[] | null> {
  try {
    const resp = await fetch(`${API_BASE}/feedback/history`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data) ? (data as FeedbackRecord[]) : null;
  } catch {
    return null;
  }
}
