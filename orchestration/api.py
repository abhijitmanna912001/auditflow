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

import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = REPO_ROOT / "dataset"

sys.path.insert(0, str(REPO_ROOT / "agents"))

from observability import configure_neatlogs, shutdown_neatlogs  # noqa: E402

configure_neatlogs()

from workpaper_agent import run_full_pipeline  # noqa: E402 (needs sys.path set first)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    shutdown_neatlogs()


app = FastAPI(title="AuditFlow Orchestration API", lifespan=lifespan)

# Allows the Next.js frontend (running on either hostname a dev server might
# bind to) to call this API directly from the browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


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
