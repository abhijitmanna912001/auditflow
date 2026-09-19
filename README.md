# AuditFlow

> Autonomous audit-evidence review for the Office of the CFO.

AuditFlow turns controlled financial-document bundles into review-ready audit workpapers. Five specialized agents cross-reference evidence, identify bounded exceptions, route them to a reviewer, and compile the result into a single workpaper.

Built for **Syndicate by Maximor — AO Hackathon**, **Track 2: Autonomous Office of the CFO**.

🚀 **[Live Demo](https://auditflow-kohl.vercel.app)** · [Backend API](https://auditflow-sxik.onrender.com) · [Demo Video](https://www.loom.com/share/674a3829f506421897b03738399a6329)

The deployed demo runs the real five-agent pipeline rather than a static frontend mock.

## Why AuditFlow?

Audit review is often slowed less by the final judgment than by collecting evidence, checking whether records agree, and documenting exceptions.

- **5 specialized AI agents** with bounded responsibilities
- **14 controlled benchmark cases** spanning clean, missing, conflicting, and multi-issue evidence
- **Evidence-backed human review** instead of silently accepting exceptions
- **Real document upload** with Claude's native PDF/image understanding, alongside the benchmark suite
- **Second-pass evidence resolution** on ambiguous cases, with disagreement surfaced rather than silently resolved
- **Persistent reviewer decisions**, building a record of confirmed vs. overturned findings

### Verified benchmark

**14 cases · 100% case-level routing accuracy on the verified benchmark run**

## Product Preview

**CASE_09 · complex exception routed to review**

![AuditFlow CASE_09 exception review](docs/screenshots/case-09-review.png)

**CASE_01 · clean transaction auto-cleared**

![AuditFlow CASE_01 clean review](docs/screenshots/case-01-clean.png)

**Controlled benchmark bundle selector**

![AuditFlow case selector](docs/screenshots/case-selector.png)

**Neatlogs execution observability**

![AuditFlow Neatlogs trace](docs/screenshots/neatlogs-trace.png)

## Five-agent pipeline

```text
Intake → Evidence → Anomaly → Decision → Workpaper
```

| Agent | Responsibility |
|---|---|
| Intake Agent | Classifies source documents and extracts structured fields. |
| Evidence Agent | Links transaction evidence and identifies missing support. |
| Anomaly Agent | Checks only the bounded exception taxonomy. |
| Decision Agent | Routes any finding to `human_review`; routes no findings to `auto_clear`. |
| Workpaper Agent | Produces the evidence-backed, review-ready workpaper. |

The bounded exception types are duplicate invoice, amount mismatch, missing PO, missing receipt, vendor mismatch, date inconsistency, currency mismatch, and tax mismatch.

### Evidence Resolver

On transactions where the Evidence Agent's first pass lands below a confidence threshold, a second independent pass runs and the two are compared. If they agree, the higher-confidence result is kept. If they disagree, both sets of findings are unioned rather than one being silently picked, and the disagreement is surfaced in the UI. This targets the CASE_06-style ambiguity noted below.

## Architecture and model strategy

AO (Agent Orchestrator) coordinates the pipeline; a FastAPI backend exposes the full run via `POST /run-case` (benchmark cases) and `POST /run-case-upload` (real documents); Neatlogs provides LLM tracing for workflow execution, model usage, latency, token consumption, and cost. Anthropic Claude is used with a focused mixed-model strategy:

| Agent | Model |
|---|---|
| Intake | Claude Sonnet 5 |
| Evidence | Claude Sonnet 5 |
| Anomaly | Claude Opus 5 |
| Decision | Claude Sonnet 5 |
| Workpaper | Claude Sonnet 5 |

The Anomaly Agent uses the stronger model because exception classification is the most nuanced reasoning step.

## Benchmark and review controls

The benchmark contains 14 controlled scenarios: clean cases, duplicate invoices, amount and currency mismatches, tax calculation errors, missing POs and receipts, vendor mismatches, date inconsistencies, multi-issue cases, and incomplete or conflicting evidence. These are evaluation fixtures—not customer audits.

**Known limitation:** `CASE_06` is an intentionally more ambiguous mixed goods/service scenario and has shown residual variance in full-sequence LLM runs even with the Evidence Resolver's second pass — documented honestly rather than hidden, since a single test run can land differently even when the resolver correctly agrees or disagrees on repeat runs.

Detected exceptions are routed to a reviewer, who can inspect the finding, evidence, confidence, rationale, and workpaper context. The current UI supports **Clear exception**, **Request evidence**, and **Escalate** actions, and every decision is persisted server-side (`POST /feedback`) and viewable in a decision history dashboard (`GET /feedback/history`).

### Upload Documents

Real PDF and image documents can be uploaded and run through the full five-agent pipeline via `POST /run-case-upload`, using Claude's native document understanding for extraction — no separate OCR step. The 14-case benchmark remains available separately for reproducible evaluation.

## Stack and deployment

| Area | Implementation |
|---|---|
| Frontend | Next.js, React, TypeScript |
| API | Python, FastAPI, Uvicorn |
| Reasoning | Anthropic Claude Sonnet 5 and Claude Opus 5 |
| Orchestration / tracing | AO (Agent Orchestrator), Neatlogs |
| Deployment | Vercel frontend, Render backend |

## Run locally

Prerequisites: Python 3.13.5, Node.js, and `ANTHROPIC_API_KEY`. Set `NEATLOGS_API_KEY` to enable tracing.

```bash
git clone https://github.com/abhijitmanna912001/auditflow.git
cd auditflow
python3.13 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
```

If `pip install` fails with `externally-managed-environment`, you're on a system Python (e.g. Homebrew) that blocks global installs by design — the `venv` step above avoids this.

```bash
# Backend
ANTHROPIC_API_KEY=your-key uvicorn orchestration.api:app --host 127.0.0.1 --port 8000

# Frontend, in a second terminal
cd frontend
npm install
npm run dev
```

The API defaults to `http://127.0.0.1:8000`; set `NEXT_PUBLIC_API_BASE_URL` to point the frontend at another backend.

## API

```http
POST /run-case
Content-Type: application/json

{ "case_id": "CASE_09" }
```

The response is the Workpaper Agent's review-ready JSON output.

```http
POST /run-case-upload?case_id=<label>&use_resolver=true
Content-Type: multipart/form-data

files: one or more PDF/PNG/JPG/JPEG/WEBP files
```

Same response shape as `/run-case`, run against real uploaded documents. `use_resolver=true` routes Evidence through the second-pass resolver.

```http
POST /feedback
Content-Type: application/json

{ "case_id": "CASE_09", "document": "INV-1009-A", "finding": "...", "agent_action": "human_review", "decision": "confirmed" }
```

Persists a reviewer decision (`confirmed`, `overturned`, or `evidence_requested`) tied to a specific finding.

```http
GET /feedback/history
```

Returns every persisted reviewer decision, oldest first.

## Repository map

```text
agents/         Five agent implementations and unit tests
orchestration/  FastAPI pipeline endpoint
dataset/        14 ground-truth cases and text document fixtures
evaluation/     Benchmark scoring and report comparison
frontend/       Next.js reviewer workspace
docs/           Agent contract and product screenshots
```

## Next steps

- Automated regression testing using the persisted reviewer feedback (overturned findings as a regression set)
- Workpaper export and broader audit-domain coverage
- Additional anomaly types beyond the current eight

## Team

- **Abhijit Manna** — agent logic, orchestration, evaluation, backend reliability, deployment
- **Garvit Mathur** — dataset, frontend, testing, integration, observability, deployment preparation

Built for **Syndicate by Maximor — AO Hackathon · Track 2: Autonomous Office of the CFO**.