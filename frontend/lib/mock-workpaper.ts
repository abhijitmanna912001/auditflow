import { confidence, type Workpaper } from "../types/workpaper";

// This object deliberately contains only the Workpaper Agent JSON contract:
// case_id, rows, and summary. Reviewer-only rationale stays out of this payload.
export const workpaperPayload: Workpaper = {
  case_id: "CASE_04",
  rows: [
    {
      document: "INV-1001",
      finding: "Clean",
      evidence: ["INV-1001", "PO-1001", "REC-1001", "BNK-1001"],
      confidence: confidence(1),
      action: "auto_clear",
    },
    {
      document: "INV-1004",
      finding: "Amount mismatch",
      evidence: ["PO-1004", "INV-1004", "REC-1004", "BNK-1004", "LED-1004"],
      confidence: confidence(0.97),
      action: "auto_clear",
    },
    {
      document: "INV-1006",
      finding: "Missing receipt",
      evidence: ["PO-1006", "INV-1006", "BNK-1006", "LED-1006"],
      confidence: confidence(0.76),
      action: "human_review",
    },
    {
      document: "INV-1007",
      finding: "Vendor mismatch",
      evidence: ["PO-1007", "INV-1007", "REC-1007", "BNK-1007", "LED-1007"],
      confidence: confidence(0.86),
      action: "human_review",
    },
  ],
  summary: {
    items_reviewed: 4,
    auto_cleared: 2,
    human_review: 2,
    critical: 3,
    assumed_minutes_per_item: 3,
    estimated_minutes_saved: 6,
  },
};
