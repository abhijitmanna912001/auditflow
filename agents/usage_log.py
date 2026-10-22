"""The one wrapper around every agent's messages.create call, and the usage
log line it writes.

create_message() builds the request from model_config, calls the model, and
writes ONE app-log line per call on the "auditflow.usage" logger:

    usage agent=anomaly model=claude-opus-5 input_tokens=1200 output_tokens=340 cache_read_tokens=0 cache_write_tokens=0 latency_ms=2100

Only the agent name, the model name and integer counts are ever written. The
agent and model are checked against an allow-list pattern and every count must
be a non-negative int, so no document text, filename, explanation, company or
id can reach the line even if one is passed in by mistake. A failure while
logging is swallowed: logging must never break a pipeline run.

Two optional hooks (contextvars, off by default) are for
evaluation/model_compare.py only: collect_usage() gathers the same counts per
call, and pre_call_guard() runs before each call and may raise to stop it.
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import re
import time
from dataclasses import dataclass
from typing import Callable, Iterator

from model_config import AGENTS, request_params

logger = logging.getLogger("auditflow.usage")
if not logger.handlers:
    # uvicorn only configures its own loggers; without a handler these INFO
    # lines would be dropped (same approach as the "auditflow.access" logger).
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)

_MODEL_PATTERN = re.compile(r"claude-[a-z0-9-]{1,40}")


@dataclass(frozen=True)
class UsageRecord:
    """Counts only. This is everything that is logged or collected."""

    agent: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    latency_ms: int


def _count(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def make_record(agent: str, model: str, usage, latency_ms) -> UsageRecord:
    """Build a record from a response's `usage` object, keeping only the
    allow-listed agent/model strings and integer counts."""
    return UsageRecord(
        agent=agent if agent in AGENTS else "unknown",
        model=model if isinstance(model, str) and _MODEL_PATTERN.fullmatch(model) else "unknown",
        input_tokens=_count(getattr(usage, "input_tokens", 0)),
        output_tokens=_count(getattr(usage, "output_tokens", 0)),
        cache_read_tokens=_count(getattr(usage, "cache_read_input_tokens", 0)),
        cache_write_tokens=_count(getattr(usage, "cache_creation_input_tokens", 0)),
        latency_ms=_count(latency_ms),
    )


def format_line(record: UsageRecord) -> str:
    return (
        f"usage agent={record.agent} model={record.model} "
        f"input_tokens={record.input_tokens} output_tokens={record.output_tokens} "
        f"cache_read_tokens={record.cache_read_tokens} cache_write_tokens={record.cache_write_tokens} "
        f"latency_ms={record.latency_ms}"
    )


_collector: contextvars.ContextVar[list | None] = contextvars.ContextVar("auditflow_usage_collector", default=None)
_guard: contextvars.ContextVar[Callable | None] = contextvars.ContextVar("auditflow_pre_call_guard", default=None)


@contextlib.contextmanager
def collect_usage() -> Iterator[list]:
    """Within the block, every create_message call also appends its
    UsageRecord to the yielded list."""
    records: list[UsageRecord] = []
    token = _collector.set(records)
    try:
        yield records
    finally:
        _collector.reset(token)


@contextlib.contextmanager
def pre_call_guard(guard: Callable[[str, dict, dict], None]) -> Iterator[None]:
    """Within the block, `guard(agent, params, kwargs)` runs before every
    model call (params: model/max_tokens/output_config; kwargs: system and
    messages). If it raises, the call is not made."""
    token = _guard.set(guard)
    try:
        yield
    finally:
        _guard.reset(token)


def record_usage(agent: str, model: str, usage, latency_ms) -> None:
    try:
        if usage is None:
            return
        record = make_record(agent, model, usage, latency_ms)
        logger.info(format_line(record))
        records = _collector.get()
        if records is not None:
            records.append(record)
    except Exception:  # never let logging break a pipeline run
        pass


def create_message(client, agent: str, output_config: dict, **kwargs):
    """client.messages.create for `agent`, with model, max_tokens and
    (optional) effort from model_config, plus the usage log line."""
    params = request_params(agent, output_config)
    guard = _guard.get()
    if guard is not None:
        guard(agent, params, kwargs)
    started = time.perf_counter()
    response = client.messages.create(**params, **kwargs)
    latency_ms = round((time.perf_counter() - started) * 1000)
    record_usage(agent, params["model"], getattr(response, "usage", None), latency_ms)
    return response
