"""Process-wide Neatlogs configuration for AuditFlow's Anthropic clients."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import TypeVar

import neatlogs

F = TypeVar("F", bound=Callable)

_configured = False


def configure_neatlogs() -> bool:
    """Initialize Anthropic tracing once, when a Neatlogs API key is configured."""
    global _configured

    if _configured:
        return True

    api_key = os.environ.get("NEATLOGS_API_KEY")
    if not api_key:
        return False

    neatlogs.init(
        api_key=api_key,
        workflow_name="auditflow",
        tags=["project:auditflow"],
        instrumentations=["anthropic"],
        register_shutdown_handlers=False,
    )
    _configured = True
    return True


def workflow(name: str) -> Callable[[F], F]:
    """Add a workflow root only when Neatlogs tracing is enabled."""
    if not configure_neatlogs():
        return lambda function: function

    return neatlogs.span(kind="WORKFLOW", name=name)


def shutdown_neatlogs() -> None:
    """Flush and stop Neatlogs once, when the API server exits."""
    if _configured:
        neatlogs.flush()
        neatlogs.shutdown()
