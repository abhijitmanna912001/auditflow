import { confidence, type Workpaper } from "../types/workpaper";

// This module now fetches real workpaper data from the backend when available.
// It exports a single function to obtain the payload matching the Workpaper contract.
export type MaybeWorkpaper = Workpaper | null;

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

export async function fetchWorkpaper(caseId: string): Promise<MaybeWorkpaper> {
  try {
    const resp = await fetch(`${API_BASE}/run-case`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case_id: caseId }),
    });
    if (!resp.ok) {
      // Let caller handle non-2xx with graceful fallback to null
      return null;
    }
    const data = await resp.json();
    // Basic shape validation; mapping layer if needed (no changes to backend)
    // Expecting { case_id, rows, summary }
    if (data?.case_id && Array.isArray(data?.rows) && data?.summary) {
      // Ensure types align by constructing a Workpaper-like object
      return data as Workpaper;
    }
    return null;
  } catch {
    return null;
  }
}

// Fallback mock payload kept for environments without backend. This will be unused once backend is available.
export const workpaperPayloadFallback: Workpaper = {
  case_id: "CASE_04",
  rows: [
    { document: "INV-1001", finding: "Clean", evidence: ["INV-1001", "PO-1001", "REC-1001", "BNK-1001"], confidence: confidence(1), action: "auto_clear" },
    { document: "INV-1004", finding: "Amount mismatch", evidence: ["PO-1004", "INV-1004", "REC-1004", "BNK-1004", "LED-1004"], confidence: confidence(0.91), action: "human_review" },
    { document: "INV-1006", finding: "Missing receipt", evidence: ["PO-1006", "INV-1006", "BNK-1006", "LED-1006"], confidence: confidence(0.76), action: "human_review" },
    { document: "INV-1007", finding: "Vendor mismatch", evidence: ["PO-1007", "INV-1007", "REC-1007", "BNK-1007", "LED-1007"], confidence: confidence(0.86), action: "human_review" },
  ],
  summary: { items_reviewed: 4, auto_cleared: 1, human_review: 3, critical: 3, assumed_minutes_per_item: 3, estimated_minutes_saved: 3 },
};
