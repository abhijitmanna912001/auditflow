"""Process-wide Neatlogs configuration for AuditFlow's Anthropic clients.

Targets neatlogs 1.1.8's real API only - see requirements.txt for why:
every neatlogs release from 1.1.9 through the current 1.4.21 requires
Python <3.14, and this project runs Python 3.14, so 1.1.8 is the newest
version that can actually install here. That version has no
workflow_name/instrumentations/register_shutdown_handlers kwargs on
init(), and no span()/flush()/shutdown() module-level functions - init()
takes only (api_key, tags, debug) and returns the LLMTracker it creates;
instrument_all() inside init() auto-patches any already-imported
"anthropic" module on its own, so there is no explicit per-provider
opt-in. LLMTracker.shutdown() on that returned instance is what actually
blocks until in-flight trace uploads finish - the real equivalent of
"flush" in this version.
"""

from __future__ import annotations

import os

import neatlogs

_tracker = None
_configured = False


def configure_neatlogs() -> bool:
    """Initialize Anthropic tracing once per process, when a Neatlogs API
    key is configured. Returns whether tracing is active."""
    global _tracker, _configured

    if _configured:
        return _tracker is not None

    _configured = True
    api_key = os.environ.get("NEATLOGS_API_KEY")
    if not api_key:
        return False

    _tracker = neatlogs.init(api_key=api_key, tags=["project:auditflow"])
    return True


def shutdown_neatlogs() -> None:
    """Block until any in-flight Neatlogs trace uploads finish. Safe to
    call repeatedly (e.g. once per agent call, and again at process exit) -
    it just joins whatever background sender threads are outstanding."""
    if _tracker is not None:
        _tracker.shutdown()
