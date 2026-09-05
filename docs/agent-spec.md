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
    findings: [
      {type: "vendor_mismatch", documents: ["INV-104", "PO-104"], severity: "medium", explanation: "Vendor name on invoice differs from PO vendor field"}
    ]

The `findings` field is carried forward unchanged from the Anomaly Agent's input for this transaction (empty list if the transaction was clean) - the Decision Agent does not modify or drop it. This is required because the Workpaper Agent (next stage) needs finding type, documents, and severity to render the workpaper row and count critical (severity=high) items, and the Decision Agent is Workpaper's only input.

action is one of: auto_clear, human_review

Threshold logic:
- confidence >= 0.95 -> auto_clear
- confidence < 0.80 -> human_review
- 0.80-0.95 -> human_review, flagged as borderline

System prompt:
You are the Decision Agent for AuditFlow. You receive anomaly findings per transaction. Using the confidence score of the highest-severity finding (or 1.0 if no findings), apply these thresholds: confidence >= 0.95 -> action auto_clear. confidence < 0.80 -> action human_review. Between 0.80 and 0.95 -> action human_review but flagged as borderline. Always output a reason field explaining the decision in plain language referencing the actual finding, and echo the thresholds used. Carry the full findings list forward unchanged from your input into your output (empty list if none) - you decide the action, you do not drop or summarize the findings data, since the next agent needs it. Never silently override the threshold logic.

---

## 5. Workpaper Agent

Input: all Decision Agent outputs for a case. Each includes the carried-forward findings list (type, documents, severity, explanation) alongside action and confidence, so Workpaper has everything it needs without re-deriving anything.

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

Each case's expected result should mirror the Anomaly + Decision shape so agent output can be automatically diffed against it. For this benchmark, every case is exactly one transaction, so transaction_id is a fixed, deterministic mapping from case_id (CASE_04 -> TXN_04) - never aggregate multiple transactions into one case file.

    case_id: "CASE_04"
    transaction_id: "TXN_04"
    expected_findings:
      - type: "vendor_mismatch"
        documents: ["INV-104", "PO-104"]
        severity: "medium"
    expected_action: "human_review"

transaction_id is required on every case file (not optional) - it is the same join key used by Evidence, Anomaly, and Decision Agent output, so ground truth must carry it too.

### Physical document fixtures (for /dataset)

Each case's source documents live in a matching subfolder, one file per document, named by document ID:

    dataset/
    |-- case_01.json              (ground truth)
    |-- case_01/
    |   |-- PO-1001.txt
    |   |-- INV-1001.txt
    |   |-- REC-1001.txt
    |   |-- BNK-1001.txt
    |   `-- LED-1001.txt
    |-- case_02.json
    |-- case_02/
    |   `-- ...

Use plain .txt fixtures (not PDFs) unless there's a specific reason to need real PDF parsing - a .txt file with the same structured content (vendor, amount, date, references) is sufficient for the Intake Agent to extract from and is far faster to generate and edit under time pressure.

Document ID naming: prefix by type - PO- (purchase order), INV- (invoice), REC- (receipt), BNK- (bank statement), LED- (ledger entry) - followed by a number matching the case (e.g. case_04's documents use the 1004 series: PO-1004, INV-1004, etc). Every document ID referenced anywhere in a case's expected_findings must have a matching fixture file in that case's subfolder - this is enforced by the validation checklist below.

### Rule for which documents belong in a finding's `documents` list

Include every document that is direct evidence for that specific finding - i.e., every document whose data (amount, vendor, date, etc.) is part of what's being compared or contradicted. Do not include a document just because it appears elsewhere in the case if it isn't part of that finding's evidence. Example: if a ledger entry independently corroborates a mismatched amount, include it; if it's silent on the amount, leave it out.

Missing evidence (an expected document that isn't present at all) is never represented as a document ID in a finding's documents list, since there's no fixture to reference. Instead, missing-evidence findings (missing_po, missing_receipt) list only the documents that ARE present and establish the absence is meaningful (e.g. an invoice that explicitly cites a PO number with no matching PO fixture in the case).

### Clean cases (no issues)

A clean case is represented with an empty findings list, NOT an invented "clean" finding type ("clean" is not one of the six allowed types):

    case_id: "CASE_01"
    expected_findings: []
    expected_action: "auto_clear"

### Validation checklist (run before committing any case file)

Every case JSON must satisfy all of the following before it's committed. All of these are enforced automatically by evaluation/evaluate.py's validate_case() when the dataset is loaded - see that file for the authoritative implementation:
- case_id is present and unique across the dataset
- transaction_id is present (deterministic CASE_NN -> TXN_NN mapping)
- expected_action is exactly one of: auto_clear, human_review (no other values)
- every expected_findings[].type is one of the six allowed types: duplicate_invoice, amount_mismatch, missing_po, missing_receipt, vendor_mismatch, date_inconsistency
- every document ID referenced in expected_findings[].documents actually exists in that case's document fixtures (dataset/case_NN/)
- a case with expected_findings: [] always has expected_action: "auto_clear" (never human_review with zero findings)
- no duplicate document IDs within a single finding's documents list
- no duplicate findings (same type + same set of documents appearing twice)


## Notes
- case_id and transaction_id are the join keys across every agent's output - never rename these fields.
- Confidence scores are always 0-1 floats, not percentages, in the data layer. Convert to percent only for display in the UI.
- The /evaluation script scores V1 vs V2 by diffing Workpaper Agent output against this ground truth, per case, producing: accuracy, false positives, missed exceptions, latency, cost.