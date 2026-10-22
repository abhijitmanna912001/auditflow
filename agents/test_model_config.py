"""Tests for model_config: defaults equal what the agents hard-coded before,
env overrides apply and are validated, and nothing new is sent unless set.
No model API calls: fakes only."""

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import model_config
from anomaly_agent import run_anomaly_agent
from decision_agent import run_decision_agent
from evidence_agent import run_evidence_agent
from intake_agent import _call_intake
from model_config import (
    DEFAULTS,
    Settings,
    load_settings,
    request_params,
    settings_for,
    use_config,
)
from model_response import ModelResponseError
from workpaper_agent import _generate_finding_labels

AGENTS_DIR = Path(__file__).resolve().parent

# Copied from the five agent files as they were before model_config existed.
TODAY = {
    "intake": "claude-sonnet-5",
    "evidence": "claude-sonnet-5",
    "anomaly": "claude-opus-5",
    "decision": "claude-sonnet-5",
    "workpaper": "claude-sonnet-5",
}


def test_defaults_equal_todays_models_and_settings():
    assert set(DEFAULTS) == set(TODAY)
    for agent, model in TODAY.items():
        assert DEFAULTS[agent] == Settings(model=model, max_tokens=16000, effort=None)


def test_no_env_means_defaults():
    assert load_settings({}) == DEFAULTS
    assert load_settings({"AUDITFLOW_MODEL_INTAKE": "", "AUDITFLOW_EFFORT_ANOMALY": "  "}) == DEFAULTS
    assert load_settings({"UNRELATED": "x"}) == DEFAULTS


def test_the_running_process_uses_defaults_when_no_variable_is_set():
    # The test environment sets no AUDITFLOW_MODEL_* / AUDITFLOW_EFFORT_* variable.
    assert model_config.SETTINGS == DEFAULTS


def test_model_override_applies_to_one_agent_only():
    loaded = load_settings({"AUDITFLOW_MODEL_ANOMALY": "claude-opus-5-5"})
    assert loaded["anomaly"].model == "claude-opus-5-5"
    assert loaded["anomaly"].max_tokens == 16000 and loaded["anomaly"].effort is None
    for agent in ("intake", "evidence", "decision", "workpaper"):
        assert loaded[agent] == DEFAULTS[agent]


def test_every_agent_has_its_own_variables():
    env = {}
    for agent in TODAY:
        env[f"AUDITFLOW_MODEL_{agent.upper()}"] = "claude-haiku-5-5"
        env[f"AUDITFLOW_EFFORT_{agent.upper()}"] = "medium"
    loaded = load_settings(env)
    assert all(s == Settings("claude-haiku-5-5", 16000, "medium") for s in loaded.values())


@pytest.mark.parametrize(
    "env, variable",
    [
        ({"AUDITFLOW_MODEL_INTAKE": "claude-not-a-model"}, "AUDITFLOW_MODEL_INTAKE"),
        ({"AUDITFLOW_MODEL_DECISION": "sk-ant-secret-value"}, "AUDITFLOW_MODEL_DECISION"),
        ({"AUDITFLOW_EFFORT_EVIDENCE": "ultra"}, "AUDITFLOW_EFFORT_EVIDENCE"),
    ],
)
def test_invalid_values_fail_naming_the_variable_but_not_the_value(env, variable):
    with pytest.raises(ValueError) as info:
        load_settings(env)
    message = str(info.value)
    assert variable in message
    assert next(iter(env.values())) not in message


def test_invalid_value_stops_the_process_at_import_without_echoing_values():
    env = {"AUDITFLOW_MODEL_ANOMALY": "claude-bogus", "SOME_SECRET": "hunter2-do-not-print", "PATH": ""}
    result = subprocess.run(
        [sys.executable, "-c", "import model_config"],
        cwd=AGENTS_DIR, env=env, capture_output=True, text=True,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "AUDITFLOW_MODEL_ANOMALY" in output
    assert "hunter2-do-not-print" not in output and "claude-bogus" not in output


def test_request_params_default_sends_nothing_new():
    fmt = {"format": {"type": "json_schema", "schema": {"type": "object"}}}
    for agent, model in TODAY.items():
        assert request_params(agent, fmt) == {
            "model": model,
            "max_tokens": 16000,
            "output_config": fmt,
        }
    assert "effort" not in request_params("intake", fmt)["output_config"]


def test_effort_is_sent_only_when_set_and_input_is_not_mutated():
    fmt = {"format": {"type": "json_schema"}}
    with use_config({"intake": Settings("claude-sonnet-5-5", 16000, "medium")}):
        params = request_params("intake", fmt)
    assert params["output_config"] == {"format": {"type": "json_schema"}, "effort": "medium"}
    assert params["model"] == "claude-sonnet-5-5"
    assert "effort" not in fmt


def test_use_config_overrides_then_restores_and_validates():
    with use_config({"anomaly": Settings("claude-sonnet-5-5")}):
        assert settings_for("anomaly").model == "claude-sonnet-5-5"
        assert settings_for("intake") == DEFAULTS["intake"]
    assert settings_for("anomaly") == DEFAULTS["anomaly"]
    with pytest.raises(ValueError):
        with use_config({"anomaly": Settings("claude-nope")}):
            pass
    with pytest.raises(ValueError):
        with use_config({"anomaly": Settings("claude-opus-5", effort="max-ish")}):
            pass
    with pytest.raises(ValueError):
        with use_config({"nobody": Settings("claude-opus-5")}):
            pass


# ---- each agent's real request reads from model_config -------------------


class _Recorder:
    """Fake client: records the request and returns a response with no text
    block, so the agent raises ModelResponseError right after the call."""

    def __init__(self):
        self.kwargs = None
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.kwargs = kwargs
        return SimpleNamespace(content=[], stop_reason="end_turn")


_DOCS = [{"doc_id": "INV-1", "case_id": "CASE_01", "type": "invoice"}]
_EVIDENCE = {"case_id": "CASE_01", "transaction_id": "TXN_01", "documents": ["INV-1"]}
_ANOMALY = {"case_id": "CASE_01", "transaction_id": "TXN_01", "findings": []}

AGENT_CALLS = {
    "intake": lambda c: _call_intake("hello", client=c),
    "evidence": lambda c: run_evidence_agent(_DOCS, client=c),
    "anomaly": lambda c: run_anomaly_agent(_EVIDENCE, _DOCS, client=c),
    "decision": lambda c: run_decision_agent(_ANOMALY, client=c),
    "workpaper": lambda c: _generate_finding_labels([{"transaction_id": "TXN_01", "findings": []}], client=c),
}


def _request_of(agent):
    client = _Recorder()
    with pytest.raises(ModelResponseError):
        AGENT_CALLS[agent](client)
    return client.kwargs


@pytest.mark.parametrize("agent", sorted(TODAY))
def test_each_agent_request_is_exactly_todays(agent):
    kwargs = _request_of(agent)
    assert kwargs["model"] == TODAY[agent]
    assert kwargs["max_tokens"] == 16000
    assert set(kwargs["output_config"]) == {"format"}
    assert set(kwargs) == {"model", "max_tokens", "output_config", "system", "messages"}


@pytest.mark.parametrize("agent", sorted(TODAY))
def test_each_agent_follows_an_override(agent):
    with use_config({agent: Settings("claude-haiku-5-5", 16000, "low")}):
        kwargs = _request_of(agent)
    assert kwargs["model"] == "claude-haiku-5-5"
    assert kwargs["output_config"]["effort"] == "low"
