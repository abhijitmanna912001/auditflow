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

import hashlib
import hmac
import json
import logging
import os
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = REPO_ROOT / "dataset"

sys.path.insert(0, str(REPO_ROOT / "agents"))

from observability import configure_neatlogs, shutdown_neatlogs  # noqa: E402
from file_map import make_unique_filenames  # noqa: E402

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
    # Content-Type: multipart/form-data uploads set this too.
    # X-Access-Code: the per-client access code (see "Access control" below).
    allow_headers=["Content-Type", "X-Access-Code"],
)

# ---------------------------------------------------------------------------
# Access control
#
# AUDITFLOW_ACCESS_CODES (JSON) maps client_id -> {"hash", "daily_runs",
# "max_files", "max_file_mb", "resolver"}. "hash" is the hex HMAC-SHA256 of
# the client's code keyed with AUDITFLOW_CODE_PEPPER (see
# scripts/make_access_code.py). When AUDITFLOW_ACCESS_CODES is unset or empty
# access control is OFF and every endpoint behaves as it always did (local
# development). When ON:
#   - /run-case-upload, /feedback and /feedback/history need a valid
#     X-Access-Code header (401 otherwise);
#   - /run-case needs no code but shares a global cap of
#     AUDITFLOW_SAMPLE_DAILY_CAP runs per UTC day (default 40, 429 beyond it);
#     with AUDITFLOW_SAMPLE_REQUIRE_CODE=true it needs a code like the rest
#     and counts against that client's daily_runs instead of the sample cap;
#   - a client's own limits apply on top of the global ceilings above.
#
# Run counters are in memory (guarded by a lock, reset on a new UTC day).
# They ALSO reset whenever the process restarts or redeploys, so they are a
# cost guard, not a durable quota.
#
# Neither codes nor hashes are ever logged.
# ---------------------------------------------------------------------------
logger = logging.getLogger("auditflow.access")
if not logger.handlers:
    # uvicorn only configures its own loggers; without this the startup line
    # and the metering lines would be dropped at the root WARNING level.
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)

_DEFAULT_CLIENT_LIMITS = {
    "daily_runs": 10,
    "max_files": 10,
    "max_file_mb": 20,
    "resolver": False,
}
_DEFAULT_SAMPLE_DAILY_CAP = 40

_access_clients: dict[str, dict] = {}
_access_enabled = False
_code_pepper = b""
_sample_daily_cap = _DEFAULT_SAMPLE_DAILY_CAP
_sample_require_code = False

_COUNTER_LOCK = threading.Lock()
_counter_day = ""
_client_runs: dict[str, int] = {}
_sample_runs = 0


def _parse_access_codes(raw: str) -> dict[str, dict]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "AUDITFLOW_ACCESS_CODES is set but is not valid JSON "
            f"({exc.msg} at line {exc.lineno} column {exc.colno}); "
            "fix or unset it."
        ) from None
    if not isinstance(parsed, dict):
        raise RuntimeError(
            "AUDITFLOW_ACCESS_CODES must be a JSON object mapping client_id to settings."
        )
    clients: dict[str, dict] = {}
    for client_id, entry in parsed.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("hash"), str):
            raise RuntimeError(
                f"AUDITFLOW_ACCESS_CODES: client {client_id!r} needs an object with a string 'hash'."
            )
        try:
            bytes.fromhex(entry["hash"])
        except ValueError:
            raise RuntimeError(
                f"AUDITFLOW_ACCESS_CODES: client {client_id!r} has a 'hash' that is not hex."
            ) from None
        settings = {**_DEFAULT_CLIENT_LIMITS, **{k: v for k, v in entry.items() if k != "hash"}}
        for key in ("daily_runs", "max_files", "max_file_mb"):
            value = settings[key]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise RuntimeError(
                    f"AUDITFLOW_ACCESS_CODES: client {client_id!r} '{key}' must be a non-negative integer."
                )
        if not isinstance(settings["resolver"], bool):
            raise RuntimeError(
                f"AUDITFLOW_ACCESS_CODES: client {client_id!r} 'resolver' must be true or false."
            )
        clients[client_id] = {"hash": entry["hash"].lower(), **{
            k: settings[k] for k in _DEFAULT_CLIENT_LIMITS
        }}
    return clients


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise RuntimeError(f"{name} must be a non-negative integer.") from None
    if value < 0:
        raise RuntimeError(f"{name} must be a non-negative integer.")
    return value


def _init_access_control() -> None:
    """Read the access-control environment. Called once at import (startup);
    raises RuntimeError with a clear message on a bad configuration."""
    global _access_clients, _access_enabled, _code_pepper
    global _sample_daily_cap, _sample_require_code

    raw = os.environ.get("AUDITFLOW_ACCESS_CODES", "").strip()
    _reset_counters()
    if not raw:
        _access_clients, _access_enabled, _code_pepper = {}, False, b""
        logger.info("Access control: OFF")
        return

    clients = _parse_access_codes(raw)
    pepper = os.environ.get("AUDITFLOW_CODE_PEPPER", "")
    if not pepper:
        raise RuntimeError(
            "AUDITFLOW_ACCESS_CODES is set but AUDITFLOW_CODE_PEPPER is not; "
            "set the pepper that was used to generate the hashes."
        )
    _sample_daily_cap = _env_int("AUDITFLOW_SAMPLE_DAILY_CAP", _DEFAULT_SAMPLE_DAILY_CAP)
    _sample_require_code = (
        os.environ.get("AUDITFLOW_SAMPLE_REQUIRE_CODE", "").strip().lower() == "true"
    )
    _access_clients, _access_enabled = clients, True
    _code_pepper = pepper.encode("utf-8")
    logger.info("Access control: ON (%d client(s))", len(clients))


def _utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _reset_counters() -> None:
    global _counter_day, _sample_runs
    with _COUNTER_LOCK:
        _counter_day, _sample_runs = _utc_day(), 0
        _client_runs.clear()


def _consume_run(client_id: str | None, limit: int) -> bool:
    """Atomically count one run against `client_id` (None = the global
    sample pool) and return False, without counting, if `limit` is reached."""
    global _counter_day, _sample_runs
    with _COUNTER_LOCK:
        today = _utc_day()
        if today != _counter_day:
            _counter_day, _sample_runs = today, 0
            _client_runs.clear()
        used = _sample_runs if client_id is None else _client_runs.get(client_id, 0)
        if used >= limit:
            return False
        if client_id is None:
            _sample_runs += 1
        else:
            _client_runs[client_id] = used + 1
        return True


def _meter(client_id: str, endpoint: str, n_files: int, outcome: str) -> None:
    # Deliberately no document text, filenames or codes.
    logger.info(
        "meter client=%s endpoint=%s files=%d outcome=%s",
        client_id, endpoint, n_files, outcome,
    )


def _authenticate(code: str | None) -> str | None:
    """Return the client_id the code belongs to, or None. Checks every
    client (no early exit) with constant-time comparison."""
    if not code:
        return None
    digest = hmac.new(_code_pepper, code.encode("utf-8"), hashlib.sha256).hexdigest()
    matched = None
    for client_id, entry in _access_clients.items():
        if hmac.compare_digest(digest, entry["hash"]) and matched is None:
            matched = client_id
    return matched


def _require_client(code: str | None, endpoint: str, n_files: int = 0) -> str:
    client_id = _authenticate(code)
    if client_id is None:
        _meter("unknown", endpoint, n_files, "unauthorized")
        raise HTTPException(status_code=401, detail="A valid access code is required")
    return client_id


def _denied(client_id: str, endpoint: str, n_files: int, outcome: str, status: int, detail: str):
    _meter(client_id, endpoint, n_files, outcome)
    return HTTPException(status_code=status, detail=detail)


_init_access_control()

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

# The first three are the current ticket-style outcomes; the last three are
# earlier values, still accepted so previously saved records stay valid.
FEEDBACK_DECISIONS = [
    "discarded",
    "assigned",
    "closed",
    "confirmed",
    "overturned",
    "evidence_requested",
]
_NOTE_REQUIRED_DECISIONS = ("discarded", "assigned", "closed")


class FeedbackRequest(BaseModel):
    case_id: str
    document: str
    finding: str
    agent_action: str
    decision: str
    note: str | None = None
    assignee: str | None = None
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
def run_case(
    request: RunCaseRequest,
    x_access_code: str | None = Header(default=None),
) -> dict:
    """Run the full pipeline against dataset/<case_id>/ and return the
    resulting Workpaper Agent output."""
    endpoint = "run-case"
    client_id = "open"
    if _access_enabled:
        if _sample_require_code:
            client_id = _require_client(x_access_code, endpoint)
        else:
            client_id = "sample"

    case_folder = DATASET_DIR / request.case_id
    if not case_folder.is_dir():
        _meter(client_id, endpoint, 0, "not_found")
        raise HTTPException(
            status_code=404,
            detail=f"No case folder found at dataset/{request.case_id}/",
        )

    if _access_enabled:
        if _sample_require_code:
            allowed = _consume_run(client_id, _access_clients[client_id]["daily_runs"])
            message = "Daily run limit reached for this access code"
        else:
            allowed = _consume_run(None, _sample_daily_cap)
            message = "Daily limit for sample cases reached; try again tomorrow"
        if not allowed:
            raise _denied(client_id, endpoint, 0, "rate_limited", 429, message)

    try:
        result = run_full_pipeline(str(case_folder) + "/")
    except Exception as exc:
        _meter(client_id, endpoint, 0, "error")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    _meter(client_id, endpoint, 0, "ok")
    return result


@app.post("/run-case-upload")
async def run_case_upload(
    case_id: str,
    files: list[UploadFile] = File(...),
    use_resolver: bool = False,
    x_access_code: str | None = Header(default=None),
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
    endpoint = "run-case-upload"
    n_files = len(files) if files else 0
    client_id = "open"
    max_files = _MAX_FILES_PER_REQUEST
    max_bytes = _MAX_UPLOAD_BYTES
    if _access_enabled:
        client_id = _require_client(x_access_code, endpoint, n_files)
        limits = _access_clients[client_id]
        if use_resolver and not limits["resolver"]:
            raise _denied(
                client_id, endpoint, n_files, "forbidden", 403,
                "The resolver is not enabled for this access code",
            )
        # Per-client limits can only tighten the global ceilings.
        max_files = min(max_files, limits["max_files"])
        max_bytes = min(max_bytes, limits["max_file_mb"] * 1024 * 1024)

    if not files:
        _meter(client_id, endpoint, 0, "rejected")
        raise HTTPException(status_code=400, detail="No files uploaded")
    if len(files) > max_files:
        raise _denied(
            client_id, endpoint, n_files, "rejected", 400,
            f"Too many files: {len(files)} (max {max_files})",
        )

    read_files: list[tuple[str, bytes]] = []
    for upload in files:
        content = await upload.read()
        if len(content) > max_bytes:
            raise _denied(
                client_id, endpoint, n_files, "rejected",
                413 if max_bytes < _MAX_UPLOAD_BYTES else 400,
                f"{upload.filename} exceeds the "
                f"{max_bytes // (1024 * 1024)} MB per-file limit",
            )
        read_files.append((upload.filename or "unnamed", content))

    # Repeated filenames are made unique ("a.pdf", "a (2).pdf") so each file
    # can be named unambiguously in the file-to-document mapping. The final
    # names are returned as `uploaded_files`, in upload order.
    final_names = make_unique_filenames([name for name, _ in read_files])
    read_files = [(name, content) for name, (_, content) in zip(final_names, read_files)]

    if _access_enabled and not _consume_run(client_id, _access_clients[client_id]["daily_runs"]):
        raise _denied(
            client_id, endpoint, n_files, "rate_limited", 429,
            "Daily run limit reached for this access code",
        )

    try:
        if use_resolver:
            result = run_full_pipeline_from_documents_with_resolver(case_id, read_files)
        else:
            result = run_full_pipeline_from_documents(case_id, read_files)
    except ValueError as exc:
        # Unsupported file type, etc. - the caller's fault, not a server error.
        _meter(client_id, endpoint, n_files, "rejected")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _meter(client_id, endpoint, n_files, "error")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    _meter(client_id, endpoint, n_files, "ok")
    return {**result, "uploaded_files": final_names}


@app.post("/feedback", status_code=201)
def submit_feedback(
    request: FeedbackRequest,
    x_access_code: str | None = Header(default=None),
) -> dict:
    """Persist one reviewer decision against a specific finding.

    Not tied to how the case was run (folder-based /run-case or uploaded
    via /run-case-upload) - case_id and document/finding are enough to
    identify what was reviewed, matching the frontend's decision-history
    dashboard, which doesn't need to re-run a case to show its own log.
    """
    client_id = _require_client(x_access_code, "feedback") if _access_enabled else "open"
    if request.decision not in FEEDBACK_DECISIONS:
        raise HTTPException(
            status_code=400,
            detail=f"decision must be one of {FEEDBACK_DECISIONS}, got {request.decision!r}",
        )
    if request.decision in _NOTE_REQUIRED_DECISIONS and not (request.note or "").strip():
        raise HTTPException(
            status_code=400,
            detail=f"a note is required for decision {request.decision!r}",
        )
    if request.decision == "assigned" and not (request.assignee or "").strip():
        raise HTTPException(
            status_code=400,
            detail="an assignee is required for decision 'assigned'",
        )

    record = request.model_dump()
    record["received_at"] = datetime.now(timezone.utc).isoformat()
    _append_feedback_record(record)
    _meter(client_id, "feedback", 0, "ok")
    return record


@app.get("/feedback/history")
def feedback_history(x_access_code: str | None = Header(default=None)) -> list[dict]:
    """All persisted reviewer decisions, oldest first by when the server
    received them (see FeedbackRequest.timestamp for why received_at, not
    the caller-supplied timestamp, is what's sorted on)."""
    client_id = _require_client(x_access_code, "feedback-history") if _access_enabled else "open"
    _meter(client_id, "feedback-history", 0, "ok")
    records = _read_feedback_records()
    return sorted(records, key=lambda r: r.get("received_at", ""))