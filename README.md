# AuditFlow

> **Autonomous audit-evidence review for the Office of the CFO.**

AuditFlow turns financial document bundles into review-ready audit workpapers.

It cross-references invoices, purchase orders, receipts, bank records, and ledger evidence, detects bounded exceptions, applies a review policy, and routes evidence-backed exceptions to a human reviewer instead of silently clearing them.

Built for **Syndicate by Maximor (AO Hackathon)**, **Track 2: Autonomous Office of the CFO**.

## Live Demo

### Frontend

https://auditflow-kohl.vercel.app

### Backend API

https://auditflow-sxik.onrender.com

The deployed system runs the real five-agent pipeline rather than a static frontend mock.

---

## What AuditFlow Solves

Traditional audit-evidence review requires people to repeatedly cross-reference:

- invoices
- purchase orders
- receipts
- bank records
- ledger entries

The tedious part is often not making the final accounting judgment. It is collecting the evidence, checking whether records agree, finding missing support, and documenting exceptions.

AuditFlow automates that evidence-review layer.

The system aims to:

1. identify what documents are present
2. connect supporting evidence
3. detect bounded audit exceptions
4. route exceptions for human review
5. produce an audit-ready workpaper

The design intentionally keeps a human reviewer in the loop for detected exceptions.

---

## Architecture

```text
Document Bundle
      │
      ▼
┌─────────────┐
│ Intake Agent│
└──────┬──────┘
       ▼
┌───────────────┐
│ Evidence Agent│
└───────┬───────┘
        ▼
┌────────────────┐
│ Anomaly Agent  │
└───────┬────────┘
        ▼
┌────────────────┐
│ Decision Agent │
└───────┬────────┘
        ▼
┌─────────────────┐
│ Workpaper Agent │
└───────┬─────────┘
        ▼
 Review-ready Workpaper
```

### Agent responsibilities

**Intake Agent**

Classifies the source documents in the audit bundle.

**Evidence Agent**

Links the transaction to supporting records and checks whether required evidence is actually present.

**Anomaly Agent**

Checks for bounded exception types such as duplicate invoices, amount mismatches, missing POs, missing receipts, vendor mismatches, and date inconsistencies.

**Decision Agent**

Applies the routing policy:

```text
Any finding      → human_review
No findings     → auto_clear
```

**Workpaper Agent**

Compiles the final evidence-backed workpaper for the reviewer.

---

## Orchestration & Observability

AuditFlow uses:

- **AO (Agent Orchestrator)** for multi-agent orchestration
- **Neatlogs** for LLM observability and tracing
- **Anthropic Claude** for agent reasoning

The pipeline is intentionally separated into bounded stages so each responsibility can be tested independently.

---

## Model Strategy

AuditFlow uses a mixed-model strategy based on observed reliability and cost.

| Agent | Model | Why |
|---|---|---|
| Intake | Claude Sonnet 5 | Fast document classification |
| Evidence | Claude Sonnet 5 | Efficient evidence extraction and linking |
| Anomaly | Claude Opus 5 | Most reasoning-intensive classification step |
| Decision | Claude Sonnet 5 | Deterministic routing/application of policy |
| Workpaper | Claude Sonnet 5 | Efficient output compilation |

The Anomaly Agent receives the stronger model because it performs the most nuanced judgment:

> Is there actually an exception, which bounded type does it represent, and how confident are we?

This keeps the expensive model focused on the stage where it provides the most value.

---

## Benchmark

AuditFlow includes **12 controlled benchmark cases** covering both clean transactions and exception scenarios.

The benchmark includes:

- clean cases
- duplicate invoices
- amount mismatches
- missing purchase orders
- missing receipts
- vendor mismatches
- date inconsistencies
- multi-issue cases
- incomplete or conflicting evidence

The cases are controlled evaluation scenarios, not real customer audits.

### Verified benchmark result

**12-case benchmark: 100% case-level routing accuracy on the verified benchmark run.**

The benchmark was also used to catch and fix several real reliability issues before the final demo, including:

- confidence-based Decision Agent routing
- overlapping Anomaly Agent classifications
- missing-receipt evidence reasoning
- model reliability differences across pipeline stages
- Neatlogs/Python compatibility issues

### Known limitation

`CASE_06` is an intentionally more ambiguous mixed goods/service scenario.

It has shown some residual variance in full-sequence LLM runs. The system has maintained precision while handling the case, and a future structural improvement would be confidence-based retry plus disagreement flagging.

This limitation is documented rather than hidden.

---

## Example Cases

### CASE_01 — Clean

Expected behavior:

```text
No findings
     ↓
auto_clear
```

AuditFlow clears the transaction when the expected supporting evidence is consistent.

### CASE_09 — Complex Exception

CASE_09 contains multiple exception signals, including:

- duplicate invoice
- amount mismatch
- missing receipt

Expected behavior:

```text
Findings detected
     ↓
human_review
```

The workpaper links the finding back to the supporting evidence so the reviewer can inspect the underlying documents.

---

## Human-in-the-Loop Review

Detected exceptions are not silently accepted.

The workpaper UI lets a reviewer inspect:

- document
- finding
- evidence
- confidence
- agent action
- decision rationale

The reviewer can then:

- **Clear exception**
- **Request evidence**
- **Escalate**

The goal is not to replace the auditor.

The goal is to reduce repetitive evidence-review work while keeping the final exception decision with a human.

---

## Upload Documents

The current hackathon demo uses controlled benchmark bundles so the evaluation scenarios remain reproducible.

The **Upload Documents** control represents the intended document-ingestion surface for a production workflow. In the current implementation, uploaded files are staged locally and are not sent through the backend five-agent pipeline.

---

## Tech Stack

### Frontend

- Next.js
- React
- TypeScript

### Backend

- Python
- FastAPI
- Uvicorn

### AI

- Anthropic Claude
- Claude Sonnet 5
- Claude Opus 5

### Orchestration & Observability

- AO (Agent Orchestrator)
- Neatlogs

### Deployment

- Vercel — frontend
- Render — backend

---

## Local Development

### Prerequisites

- Python 3.13.5
- Node.js
- Anthropic API key

The repository pins Python 3.13.5 for deployment compatibility.

### 1. Clone

```bash
git clone https://github.com/abhijitmanna912001/auditflow.git
cd auditflow
```

### 2. Install backend dependencies

```bash
pip install -r requirements.txt
```

Set:

```bash
ANTHROPIC_API_KEY=your-key
```

Neatlogs tracing can be enabled with:

```bash
NEATLOGS_API_KEY=your-key
```

### 3. Start the backend

```bash
uvicorn orchestration.api:app --host 127.0.0.1 --port 8000
```

The API is available at:

```text
http://127.0.0.1:8000
```

### 4. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs at:

```text
http://localhost:3000
```

The frontend uses:

```text
NEXT_PUBLIC_API_BASE_URL
```

to configure the backend URL, with localhost as the development fallback.

---

## API

Run an audit case with:

```http
POST /run-case
```

Example:

```json
{
  "case_id": "CASE_09"
}
```

Example local request:

```bash
curl -X POST http://127.0.0.1:8000/run-case \
  -H "Content-Type: application/json" \
  -d '{"case_id":"CASE_09"}'
```

The API returns the Workpaper Agent's review-ready JSON output.

---

## Project Structure

```text
auditflow/
├── agents/
│   ├── intake_agent.py
│   ├── evidence_agent.py
│   ├── anomaly_agent.py
│   ├── decision_agent.py
│   ├── workpaper_agent.py
│   └── observability.py
│
├── orchestration/
│   └── api.py
│
├── evaluation/
│   └── benchmark tooling
│
├── frontend/
│   ├── components/
│   ├── lib/
│   └── ...
│
├── dataset/
│   ├── CASE_01/
│   ├── CASE_02/
│   ├── ...
│   └── CASE_12/
│
├── docs/
├── requirements.txt
├── runtime.txt
└── README.md
```

---

## Engineering Approach

AuditFlow was developed around repeated validation rather than a single happy-path demo.

During development we:

- benchmarked all 12 cases
- tested clean and exception scenarios
- verified routing behavior
- investigated classification boundary failures
- tested missing-evidence reasoning
- validated model reliability
- validated LLM observability
- used separate PRs for focused changes
- verified frontend builds independently
- tested the live frontend against the real backend

The result is a system designed to be **observable, testable, and reviewable**, not just visually convincing.

---

## Future Improvements

Potential next steps include:

- confidence-based retries
- disagreement detection between independent reasoning passes
- persistent reviewer decisions
- full arbitrary-document ingestion
- richer audit-history and workpaper export
- additional benchmark cases and audit domains

---

## Team

**Abhijit Manna**

Agent logic, orchestration, evaluation, backend reliability, deployment

**Garvit Mathur**

Dataset, frontend, testing, integration, observability, deployment preparation

---

## Hackathon

Built for:

**Syndicate by Maximor — AO Hackathon**

**Track 2: Autonomous Office of the CFO**
