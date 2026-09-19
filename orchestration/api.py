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

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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