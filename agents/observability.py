"""Process-wide Neatlogs configuration for AuditFlow's Anthropic clients.

Targets the current neatlogs API (1.4.13+, verified against 1.4.23) after
upgrading off 1.1.8. The old 1.1.8 pin existed only because every neatlogs
release from 1.1.9 through 1.4.21 declared python_requires<3.14, and this
project's Python 3.14 environment couldn't install anything newer - see
neatlogs/neatlogs#91 for the investigation. Neatlogs has since fixed the
Python constraint and separately shipped a real backend-routing fix (the
1.1.8 client posted to a retired https://app.neatlogs.com/api/data/v2
route; current releases post to https://ingest.neatlogs.com by default),
so 1.1.8 is no longer the newest installable version and no longer the
only version that actually delivers traces.

module-level init(api_key=..., tags=..., instrumentations=["anthropic"])
and module-level shutdown() are both real, current API surface (confirmed
directly against the installed package, not just from the changelog).
neatlogs.get_tracker() is gone in current releases - shutdown() no longer
needs a tracker instance to call it on.
"""

from __future__ import annotations

import os

import neatlogs

_configured = False
_active = False


def configure_neatlogs() -> bool:
    """Initialize Anthropic tracing once per process, when a Neatlogs API
    key is configured. Returns whether tracing is active."""
    global _configured, _active

    if _configured:
        return _active

    _configured = True
    api_key = os.environ.get("NEATLOGS_API_KEY")
    if not api_key:
        return False

    neatlogs.init(
        api_key=api_key,
        tags=["project:auditflow"],
        instrumentations=["anthropic"],
    )
    _active = True
    return True


def shutdown_neatlogs() -> None:
    """Block until any in-flight Neatlogs trace uploads finish. Safe to
    call repeatedly (e.g. once per agent call, and again at process exit) -
    it's a no-op if tracing was never configured or already shut down."""
    if _active:
        neatlogs.shutdown()