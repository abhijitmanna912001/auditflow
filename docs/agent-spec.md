# AuditFlow - Agent Specification

This is the single source of truth for the 5-agent pipeline: data contracts (JSON shapes passed between agents) and the system prompts each agent runs on. Both the agent implementation (/agents, /orchestration) and the benchmark ground truth (/dataset) must conform to these shapes.

Pipeline: Intake -> Evidence -> Anomaly -> Decision -> Workpaper

---

## 1. Intake Agent

Input: raw case folder - a set of documents (invoice(s), receipt(s), purchase order(s), bank statement, ledger) for one audit case.

Job: classify each document by type and extract structured fields.

Output schema - one object per document:

    doc_id: "INV-104"
    type: "invoice"
    vendor: "Acme Supplies"
    amount: 85000
    currency: "INR"
    date: "2026-08-12"
    references: ["PO-104"]
    case_id: "CASE_04"
    extraction_notes: null

type is one of: invoice, receipt, purchase_order, bank_statement, ledger_entry

System prompt:
You are the Intake Agent for AuditFlow. You receive raw financial documents (invoices, receipts, purchase orders, bank statements, ledger entries) for one audit case. For each document, extract: document ID, document type, vendor name, amount, currency, date, and any reference IDs to other documents (e.g., a PO number cited on an invoice). Output one JSON object per document following the schema above. If a field cannot be determined, set it to null and note why in an extraction_notes field. Do not guess amounts or dates - flag uncertainty rather than fabricate.

---

## 2. Evidence Agent

Input: Intake Agent's structured output for the case.

Job: group documents into transactions by shared references; determine what's present/missing.

Output schema - one object per transaction:

    transaction_id: "TXN_04"
    case_id: "CASE_04"
    documents: ["INV-104", "PO-104"]
    missing_evidence: ["bank_statement"]
    evidence_confidence: 0.82
    notes: "Invoice present, PO present, no matching bank transaction found"

System prompt:
You are the Evidence Agent for AuditFlow. You receive structured documents from the Intake Agent for one case. Group documents into transactions based on shared references (e.g., an invoice and its PO). For each transaction, determine: which documents are present, which expected supporting documents are missing (e.g., an invoice with no matching bank transaction), and an evidence_confidence score (0-1) reflecting how well-supported the transaction is. If a document type is missing, check whether that's expected (e.g., some vendors are PO-exempt - infer this only from patterns in the provided documents, never assume). Output one JSON object per transaction following the schema above.

---

## 3. Anomaly Agent

Input: Evidence Agent's transaction evidence maps.

Job: check for a fixed, bounded set of issue types.

Output schema - one object per transaction:

    transaction_id: "TXN_04"
    case_id: "CASE_04"
    findings:
      - type: "vendor_mismatch"
        documents: ["INV-104", "PO-104"]
        severity: "medium"
        confidence: 0.81
        explanation: "Vendor name on invoice differs from PO vendor field"

findings[].type is one of: duplicate_invoice, amount_mismatch, missing_po, missing_receipt, vendor_mismatch, date_inconsistency - no other categories.
findings[].severity is one of: low, medium, high
findings may be an empty list (clean transaction).

System prompt:
You are the Anomaly Agent for AuditFlow. You receive transaction evidence maps from the Evidence Agent. For each transaction, check for exactly these issue types only: duplicate_invoice, amount_mismatch, missing_po, missing_receipt, vendor_mismatch, date_inconsistency. Do not invent other categories. For each issue found, output: type, the documents involved, a severity (low/medium/high), a confidence score (0-1), and a one-sentence explanation. A transaction can have zero, one, or multiple findings. If no issues are found, output an empty findings list - do not force a finding.

---

## 4. Decision Agent

Input: Anomaly Agent's findings per transaction.

Job: apply confidence thresholds to decide auto-clear vs human review.

Output schema - one object per transaction:

    transaction_id: "TXN_04"
    case_id: "CASE_04"
    action: "human_review"
    confidence: 0.81
    reason: "Vendor mismatch detected with medium confidence, below 95% auto-clear threshold"
    thresholds_used: {auto_clear: 0.95, human_review: 0.80}

action is one of: auto_clear, human_review

Threshold logic:
- confidence >= 0.95 -> auto_clear
- confidence < 0.80 -> human_review
- 0.80-0.95 -> human_review, flagged as borderline

System prompt:
You are the Decision Agent for AuditFlow. You receive anomaly findings per transaction. Using the confidence score of the highest-severity finding (or 1.0 if no findings), apply these thresholds: confidence >= 0.95 -> action auto_clear. confidence < 0.80 -> action human_review. Between 0.80 and 0.95 -> action human_review but flagged as borderline. Always output a reason field explaining the decision in plain language referencing the actual finding, and echo the thresholds used. Never silently override the threshold logic.

---

## 5. Workpaper Agent

Input: all Decision Agent outputs for a case.

Job: compile the final workpaper - this is the exact JSON the frontend renders.

Output schema:

    case_id: "CASE_04"
    rows:
      - document: "INV-104"
        finding: "Vendor mismatch"
        evidence: ["INV-104", "PO-104"]
        confidence: 0.81
        action: "human_review"
    summary:
      items_reviewed: 18
      auto_cleared: 14
      human_review: 3
      critical: 1
      assumed_minutes_per_item: 3
      estimated_minutes_saved: 318

System prompt:
You are the Workpaper Agent for AuditFlow. You receive all Decision Agent outputs for a case. Compile a workpaper: one row per transaction with document, finding (plain-language summary, or Clean if none), evidence (document IDs), confidence, and action. Add a summary block: items_reviewed, auto_cleared count, human_review count, critical count (severity=high items), and an estimated_minutes_saved calculated as (auto_cleared_count times assumed_minutes_per_item), where assumed_minutes_per_item is a configurable input (default 3). State the assumption explicitly in the output - never present the time-saved number without it.

---

## Ground truth format (for /dataset)

Each case's expected result should mirror the Anomaly + Decision shape so agent output can be automatically diffed against it:

    case_id: "CASE_04"
    expected_findings:
      - type: "vendor_mismatch"
        documents: ["INV-104", "PO-104"]
        severity: "medium"
    expected_action: "human_review"

### Clean cases (no issues)

A clean case is represented with an empty findings list, NOT an invented "clean" finding type ("clean" is not one of the six allowed types):

    case_id: "CASE_01"
    expected_findings: []
    expected_action: "auto_clear"

### Validation checklist (run before committing any case file)

Every case JSON must satisfy all of the following before it's committed:
- case_id is present and unique across the dataset
- expected_action is exactly one of: auto_clear, human_review (no other values)
- every expected_findings[].type is one of the six allowed types: duplicate_invoice, amount_mismatch, missing_po, missing_receipt, vendor_mismatch, date_inconsistency
- every document ID referenced in expected_findings[].documents actually exists in that case's document set
- a case with expected_findings: [] always has expected_action: "auto_clear" (never human_review with zero findings)

## Notes
- case_id and transaction_id are the join keys across every agent's output - never rename these fields.
- Confidence scores are always 0-1 floats, not percentages, in the data layer. Convert to percent only for display in the UI.
- The /evaluation script scores V1 vs V2 by diffing Workpaper Agent output against this ground truth, per case, producing: accuracy, false positives, missed exceptions, latency, cost.
