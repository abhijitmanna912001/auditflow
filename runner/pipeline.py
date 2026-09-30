"""Adapter around the existing five-agent pipeline (agents/ is not modified).

run_full_pipeline_from_documents() returns only the workpaper, which merges a transaction's findings
into one row. A ticket per finding needs the per-finding type, cited documents and explanation, which
the Decision Agent produces on the way. So this adapter calls run_full_pipeline_from_documents() and
records the Decision Agent's output (and the Intake documents) by wrapping those two module attributes for
the duration of the call. Not thread-safe: run groups one at a time. If agents/ later returns findings
directly, delete the wrapper and read them from the result.
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parent.parent / "agents"
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

import workpaper_agent as _wa  # noqa: E402  (agents use flat imports, hence the path tweak above)


@contextmanager
def _capture(store: dict):
    orig_decision, orig_intake = _wa.run_decision_agent, _wa.run_intake_agent_from_documents
    def decision(*a, **k):
        r = orig_decision(*a, **k)
        store["decision"] = r
        return r
    def intake(*a, **k):
        r = orig_intake(*a, **k)
        store["intake"] = r
        return r
    _wa.run_decision_agent, _wa.run_intake_agent_from_documents = decision, intake
    try:
        yield
    finally:
        _wa.run_decision_agent, _wa.run_intake_agent_from_documents = orig_decision, orig_intake


def run_group(label: str, files: list[tuple[str, bytes]]) -> dict:
    """Returns {workpaper, decision, intake}. `decision` holds action, confidence and findings[]."""
    store: dict = {}
    with _capture(store):
        workpaper = _wa.run_full_pipeline_from_documents(label, files)
    if "decision" not in store:
        raise RuntimeError("pipeline finished without a Decision Agent result")
    return {"workpaper": workpaper, "decision": store["decision"], "intake": store.get("intake", [])}


def intake_one(name: str, data: bytes) -> list[dict]:
    """Existing Intake Agent on ONE file so each extracted document can be tied to its file."""
    docs = _wa.run_intake_agent_from_documents("RUN", [(name, data)])
    for d in docs:
        d["case_id"] = "RUN"
    return docs
