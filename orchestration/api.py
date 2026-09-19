"""Minimal local orchestration API for AuditFlow.

Exposes the full 5-agent pipeline (Intake -> Evidence -> Anomaly -> Decision
-> Workpaper) over HTTP: POST a case_id, get back the real Workpaper Agent
JSON for that case.

Requires ANTHROPIC_API_KEY set in the environment before starting - the
agents resolve it via the Anthropic SDK's default credential lookup, same
as running them directly from the command line.

Run (from the repo root):
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...
    uvicorn orchestration.api:app --reload --port 8000

Call:
    curl -X POST http://127.0.0.1:8000/run-case \
        -H "Content-Type: application/json" \
        -d '{"case_id": "CASE_09"}'
"""

from __future__ import annotations

import json
import os
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = REPO_ROOT / "dataset"

sys.path.insert(0, str(REPO_ROOT / "agents"))

from observability import configure_neatlogs, shutdown_neatlogs  # noqa: E402

configure_neatlogs()

from workpaper_agent import (  # noqa: E402 (needs sys.path set first)
    run_full_pipeline,
    run_full_pipeline_from_documents,
    run_full_pipeline_from_documents_with_resolver,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    shutdown_neatlogs()


app = FastAPI(title="AuditFlow Orchestration API", lifespan=lifespan)

# Allows the Next.js frontend to call this API directly from the browser.
# ALLOWED_ORIGINS (comma-separated) lets a deployment add its real frontend
# URL via an environment variable, with no code change - falls back to the
# local dev server's two possible hostnames when unset.
_DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]
_allowed_origins_env = os.environ.get("ALLOWED_ORIGINS")
allowed_origins = (
    [origin.strip() for origin in _allowed_origins_env.split(",") if origin.strip()]
    if _allowed_origins_env
    else _DEFAULT_ALLOWED_ORIGINS
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type"],  # multipart/form-data uploads set this too
)

# Uploads are capped well above any real audit document (typically a few MB)
# but far below anything that would stall a synchronous request/response
# cycle while Claude processes it.
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB per file
_MAX_FILES_PER_REQUEST = 10

# Reviewer feedback persistence: a single JSON file, append-only. Chosen
# over a real database for today's timeframe - zero setup, survives a
# server restart (unlike pure in-memory), and the data volume (one record
# per reviewer click, for one day's demo) is trivially small. A write lock
# guards against two concurrent requests corrupting the file; FastAPI can
# serve requests concurrently even though this app has no other shared
# mutable state today.
_FEEDBACK_FILE = REPO_ROOT / "orchestration" / "feedback_log.json"
_FEEDBACK_LOCK = threading.Lock()

FEEDBACK_DECISIONS = ["confirmed", "overturned", "evidence_requested"]


class FeedbackRequest(BaseModel):
    case_id: str
    document: str
    finding: str
    agent_action: str
    decision: str
    note: str | None = None
    # Caller-supplied timestamp is accepted (e.g. the moment the reviewer
    # clicked, if the frontend wants to own that) but never trusted for
    # ordering - the server also stamps its own received_at, which
    # GET /feedback/history sorts by, so clock skew or a missing/malformed
    # client timestamp can't corrupt the history order.
    timestamp: str | None = None


def _read_feedback_records() -> list[dict]:
    if not _FEEDBACK_FILE.exists():
        return []
    with _FEEDBACK_FILE.open("r", encoding="utf-8") as f:
        return json.load(f)


def _append_feedback_record(record: dict) -> None:
    with _FEEDBACK_LOCK:
        records = _read_feedback_records()
        records.append(record)
        with _FEEDBACK_FILE.open("w", encoding="utf-8") as f:
            json.dump(records, f, indent=2)


class RunCaseRequest(BaseModel):
    case_id: str


@app.post("/run-case")
def run_case(request: RunCaseRequest) -> dict:
    """Run the full pipeline against dataset/<case_id>/ and return the
    resulting Workpaper Agent output."""
    case_folder = DATASET_DIR / request.case_id
    if not case_folder.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"No case folder found at dataset/{request.case_id}/",
        )

    try:
        return run_full_pipeline(str(case_folder) + "/")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/run-case-upload")
async def run_case_upload(
    case_id: str,
    files: list[UploadFile] = File(...),
    use_resolver: bool = False,
) -> dict:
    """Run the full pipeline against real uploaded documents (PDF/image)
    instead of a fixed benchmark case folder. `case_id` is caller-supplied
    (e.g. a generated ID or a user-facing label) - it's only used to label
    the case in the pipeline output, not to look anything up on disk.

    use_resolver=true routes the Evidence Agent step through the resolver
    (a second independent pass on low-confidence transactions, per
    evidence_agent.RESOLVER_CONFIDENCE_THRESHOLD) - the CASE_06 fix. Left
    off by default so the plain upload path stays a single, predictable
    Evidence call; callers that want the resolver ask for it explicitly.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    if len(files) > _MAX_FILES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files: {len(files)} (max {_MAX_FILES_PER_REQUEST})",
        )

    read_files: list[tuple[str, bytes]] = []
    for upload in files:
        content = await upload.read()
        if len(content) > _MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{upload.filename} exceeds the "
                    f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB per-file limit"
                ),
            )
        read_files.append((upload.filename or "unnamed", content))

    try:
        if use_resolver:
            return run_full_pipeline_from_documents_with_resolver(case_id, read_files)
        return run_full_pipeline_from_documents(case_id, read_files)
    except ValueError as exc:
        # Unsupported file type, etc. - the caller's fault, not a server error.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/feedback", status_code=201)
def submit_feedback(request: FeedbackRequest) -> dict:
    """Persist one reviewer decision against a specific finding.

    Not tied to how the case was run (folder-based /run-case or uploaded
    via /run-case-upload) - case_id and document/finding are enough to
    identify what was reviewed, matching the frontend's decision-history
    dashboard, which doesn't need to re-run a case to show its own log.
    """
    if request.decision not in FEEDBACK_DECISIONS:
        raise HTTPException(
            status_code=400,
            detail=f"decision must be one of {FEEDBACK_DECISIONS}, got {request.decision!r}",
        )

    record = request.model_dump()
    record["received_at"] = datetime.now(timezone.utc).isoformat()
    _append_feedback_record(record)
    return record


@app.get("/feedback/history")
def feedback_history() -> list[dict]:
    """All persisted reviewer decisions, oldest first by when the server
    received them (see FeedbackRequest.timestamp for why received_at, not
    the caller-supplied timestamp, is what's sorted on)."""
    records = _read_feedback_records()
    return sorted(records, key=lambda r: r.get("received_at", ""))