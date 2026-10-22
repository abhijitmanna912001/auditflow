"""One place for the model and optional settings each agent uses.

Defaults equal what the agents hard-coded before: the model below and
max_tokens=16000, with no effort or any other new parameter sent. A model or
setting changes only when an environment variable is set on the server:

    AUDITFLOW_MODEL_<AGENT>       e.g. AUDITFLOW_MODEL_INTAKE=claude-sonnet-5-5
    AUDITFLOW_EFFORT_<AGENT>      low | medium | high | xhigh | max (optional)

with <AGENT> one of INTAKE, EVIDENCE, ANOMALY, DECISION, WORKPAPER. Rolling
back is deleting the variable. The variables are read and validated once, at
import: a model that is not in agents/price_table.py (so could not be costed)
or an unknown effort stops the process with a message naming the variable.
The message never repeats any value from the environment.

temperature, top_p, top_k and thinking are deliberately not configurable.
"""

from __future__ import annotations

import contextlib
import contextvars
import os
from dataclasses import dataclass, replace
from typing import Iterator, Mapping

from price_table import known_models

AGENTS = ("intake", "evidence", "anomaly", "decision", "workpaper")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_MAX_TOKENS = 16000


@dataclass(frozen=True)
class Settings:
    model: str
    max_tokens: int = DEFAULT_MAX_TOKENS
    effort: str | None = None  # None: not sent, the API default applies


# Exactly what each agent hard-coded before this module existed.
DEFAULTS: dict[str, Settings] = {
    "intake": Settings("claude-sonnet-5"),
    "evidence": Settings("claude-sonnet-5"),
    "anomaly": Settings("claude-opus-5"),
    "decision": Settings("claude-sonnet-5"),
    "workpaper": Settings("claude-sonnet-5"),
}


def _check_model(model: str, source: str) -> str:
    if model not in known_models():
        raise ValueError(
            f"{source} is not a known model; it must be one of: {', '.join(known_models())}"
        )
    return model


def _check_effort(effort: str, source: str) -> str:
    if effort not in EFFORTS:
        raise ValueError(f"{source} is not a valid effort; it must be one of: {', '.join(EFFORTS)}")
    return effort


def load_settings(environ: Mapping[str, str]) -> dict[str, Settings]:
    """DEFAULTS with any AUDITFLOW_MODEL_<AGENT> / AUDITFLOW_EFFORT_<AGENT>
    overrides from `environ` applied. Empty values count as unset."""
    settings = dict(DEFAULTS)
    for agent in AGENTS:
        model_var = f"AUDITFLOW_MODEL_{agent.upper()}"
        effort_var = f"AUDITFLOW_EFFORT_{agent.upper()}"
        model = environ.get(model_var, "").strip()
        effort = environ.get(effort_var, "").strip()
        if model:
            settings[agent] = replace(settings[agent], model=_check_model(model, model_var))
        if effort:
            settings[agent] = replace(settings[agent], effort=_check_effort(effort, effort_var))
    return settings


SETTINGS: dict[str, Settings] = load_settings(os.environ)

# Per-process override used by evaluation/model_compare.py to run one
# configuration without touching the environment.
_override: contextvars.ContextVar[Mapping[str, Settings] | None] = contextvars.ContextVar(
    "auditflow_model_override", default=None
)


@contextlib.contextmanager
def use_config(overrides: Mapping[str, Settings]) -> Iterator[None]:
    """Within the block, `overrides` (agent -> Settings; agents left out keep
    their normal settings) beat the environment. Validated like env values."""
    for agent, s in overrides.items():
        if agent not in AGENTS:
            raise ValueError(f"unknown agent {agent!r}")
        _check_model(s.model, f"override model for {agent}")
        if s.effort is not None:
            _check_effort(s.effort, f"override effort for {agent}")
    token = _override.set({**SETTINGS, **overrides})
    try:
        yield
    finally:
        _override.reset(token)


def settings_for(agent: str) -> Settings:
    active = _override.get()
    return (active if active is not None else SETTINGS)[agent]


def request_params(agent: str, output_config: dict) -> dict:
    """model, max_tokens and output_config for an agent's messages.create
    call. `effort` is added to output_config only when it is set."""
    s = settings_for(agent)
    config = dict(output_config)
    if s.effort is not None:
        config["effort"] = s.effort
    return {"model": s.model, "max_tokens": s.max_tokens, "output_config": config}
