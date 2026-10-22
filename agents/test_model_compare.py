"""Tests for evaluation/model_compare.py helpers and its run loop. No model API
calls: a fake client answers the real production agents' requests."""

import json
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "evaluation"))

import evaluate  # noqa: E402
import model_compare as mc  # noqa: E402
from model_response import ModelResponseError, ModelResponseFormatError  # noqa: E402

DATASET = REPO_ROOT / "dataset"
GROUND_TRUTH = evaluate.load_ground_truth(str(DATASET))
REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


# ---- a fake client that answers the real agents ---------------------------


class FakeClient:
    """Answers each agent's request with a schema-correct reply, recognising
    the agent by its system prompt. `findings_for(case_id)` gives the finding
    types the Anomaly reply should contain. `failures[model]` makes calls to
    that model raise (an exception) or return a bad response (a callable)."""

    def __init__(self, findings_for=None, failures=None, usage=(1000, 200)):
        self.findings_for = findings_for or (lambda case_id: [])
        self.failures = failures or {}
        self.usage = usage
        self.requests = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw):
        self.requests.append(kw)
        failure = self.failures.get(kw["model"])
        if isinstance(failure, BaseException):
            raise failure
        if failure is not None:
            return failure(kw)
        system, user = kw["system"], kw["messages"][0]["content"]
        number = re.search(r"(?:CASE|TXN)_(\d+)", user)
        case_id = f"CASE_{number.group(1)}" if number else "CASE_00"
        txn = f"TXN_{case_id[-2:]}"
        if system.startswith("You are the Intake Agent"):
            body = {"documents": [{
                "doc_id": "INV-1", "type": "invoice", "vendor": "V", "amount": 100.0, "tax_amount": None,
                "subtotal": None, "currency": "INR", "date": "2026-01-01", "references": [],
                "case_id": case_id, "extraction_notes": None}]}
        elif system.startswith("You are the Evidence Agent"):
            body = {"transactions": [{"transaction_id": txn, "case_id": case_id, "documents": ["INV-1"],
                                      "missing_evidence": [], "evidence_confidence": 0.9, "notes": "n"}]}
        elif system.startswith("You are the Anomaly Agent"):
            body = {"transactions": [{"transaction_id": txn, "case_id": case_id, "findings": [
                {"type": t, "documents": ["INV-1"], "severity": "high", "confidence": 0.9, "explanation": "e"}
                for t in self.findings_for(case_id)]}]}
        elif system.startswith("You are the Decision Agent"):
            body = {"transactions": [{"reason": "r"}]}
        else:
            body = {"rows": [{"transaction_id": txn, "finding_summary": "Some finding"}]}
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=json.dumps(body))],
            stop_reason="end_turn",
            usage=SimpleNamespace(input_tokens=self.usage[0], output_tokens=self.usage[1],
                                  cache_read_input_tokens=0, cache_creation_input_tokens=0),
        )


def perfect(case_id):
    return [f["type"] for f in GROUND_TRUTH[case_id]["expected_findings"]]


def run(schedule, client, cap=100.0, tmp_path=None, effort="medium"):
    path = tmp_path / "runs.jsonl"
    results, stopped = mc.run_benchmark(
        schedule, GROUND_TRUTH, DATASET, client, evaluate, cap, effort, path, progress=lambda *_: None
    )
    return results, stopped, path


# ---- import safety --------------------------------------------------------


def test_import_does_nothing():
    code = (
        "import sys; before = list(sys.path); import model_compare; "
        "assert sys.path == before, 'sys.path changed'; "
        "assert 'anthropic' not in sys.modules and 'model_config' not in sys.modules and 'evaluate' not in sys.modules; "
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=REPO_ROOT / "evaluation", capture_output=True, text=True,
        env={"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.stdout.strip() == "ok", result.stderr


def test_file_name_is_not_collected_by_pytest():
    name = Path(mc.__file__).name
    assert not name.startswith("test_") and not name.endswith("_test.py")


# ---- configs and schedule -------------------------------------------------


def test_configs_follow_the_design():
    assert mc.CONFIG_MODELS["A"] == {
        "intake": "claude-sonnet-5", "evidence": "claude-sonnet-5", "anomaly": "claude-opus-5",
        "decision": "claude-sonnet-5", "workpaper": "claude-sonnet-5"}
    assert mc.CONFIG_MODELS["B"]["anomaly"] == "claude-opus-5-5"
    assert {mc.CONFIG_MODELS["B"][a] for a in ("intake", "evidence", "decision", "workpaper")} == {"claude-sonnet-5-5"}
    assert set(mc.CONFIG_MODELS["C"].values()) == {"claude-sonnet-5-5"}
    assert [a for a, m in mc.CONFIG_MODELS["D"].items() if m == "claude-haiku-5-5"] == ["decision", "workpaper"]
    assert mc.CONFIG_MODELS["D"]["anomaly"] == "claude-sonnet-5-5"


def test_effort_is_none_for_a_and_the_same_for_the_rest_and_max_is_refused():
    assert mc.config_effort("A", "medium") is None
    assert {mc.config_effort(c, "medium") for c in "BCD"} == {"medium"}
    assert "effort not set" in mc.config_description("A", "medium")
    assert "effort medium" in mc.config_description("B", "medium")
    with pytest.raises(SystemExit):
        mc.parse_args(["--effort", "max"])


def test_config_a_settings_equal_production_defaults():
    from model_config import DEFAULTS

    assert mc.config_settings("A", "medium") == DEFAULTS


def test_schedule_interleaves_configs_and_is_seeded():
    cases = ["CASE_01", "CASE_02", "CASE_03", "CASE_04"]
    schedule = mc.build_schedule(cases, list("ABCD"), 3, seed=7)
    assert len(schedule) == 4 * 4 * 3
    for repeat in (1, 2, 3):
        for case in cases:
            assert sorted(c for r, k, c in schedule if r == repeat and k == case) == list("ABCD")
    # every (repeat, case) group is contiguous, so configs sit side by side in time
    assert [(r, k) for r, k, _ in schedule[:4]] == [(1, "CASE_01")] * 4
    assert schedule == mc.build_schedule(cases, list("ABCD"), 3, seed=7)
    assert schedule != mc.build_schedule(cases, list("ABCD"), 3, seed=8)
    assert len({c for (_, _, c) in schedule[::4]}) > 1  # not always the same config first


# ---- estimates and the cap guard -----------------------------------------


def test_input_estimate_is_pessimistic_and_counts_blocks_and_schema():
    assert mc.estimate_input_tokens("a" * 250, [{"role": "user", "content": "b" * 250}]) == 200
    blocks = [{"role": "user", "content": [{"type": "text", "text": "x" * 25}, {"type": "document"}]}]
    assert mc.estimate_input_tokens("", blocks) == 10 + mc.NON_TEXT_BLOCK_TOKENS
    assert mc.estimate_input_tokens("", [], {"format": {"s": "y" * 100}}) > 40


def test_worst_case_cost_hand_computed():
    # 10,000 in x $5 + 16,000 out x $25, per million
    assert mc.worst_case_cost("claude-opus-5", 10_000, 16_000) == pytest.approx(0.05 + 0.40)


def test_guard_blocks_the_call_that_could_pass_the_cap_and_never_overspends():
    from usage_log import collect_usage, create_message, pre_call_guard

    client = FakeClient(usage=(1000, 200))
    fmt = {"format": {"type": "json_schema", "schema": {}}}
    made = 0
    with collect_usage() as records, pre_call_guard(mc.SpendGuard(0.60, records)):
        with pytest.raises(mc.SpendCapExceeded):
            for _ in range(1000):
                create_message(client, "anomaly", fmt, system="s", messages=[{"role": "user", "content": "CASE_01"}])
                made += 1
    spent = mc.SpendGuard(0.60, records).spent()
    assert made >= 1 and made == len(client.requests) == len(records)
    assert spent <= 0.60
    # one more worst-case anomaly call (about $0.40) would not fit under the cap
    assert spent + mc.worst_case_cost("claude-opus-5", 60, 16000) > 0.60


def test_guard_allows_calls_under_the_cap():
    from usage_log import collect_usage, create_message, pre_call_guard

    client = FakeClient()
    with collect_usage() as records, pre_call_guard(mc.SpendGuard(5.0, records)):
        create_message(client, "decision", {"format": {}}, system="s", messages=[{"role": "user", "content": "x"}])
    assert len(client.requests) == 1


# ---- failure causes -------------------------------------------------------


@pytest.mark.parametrize(
    "exc, cause",
    [
        (ModelResponseError("intake", "refusal"), "refusal"),
        (ModelResponseError("intake", "no_text"), "no_text"),
        (ModelResponseFormatError("intake", "truncated"), "truncated"),
        (ModelResponseFormatError("intake", "parse"), "parse"),
        (mc.SpendCapExceeded("cap"), "cap_stop"),
        (anthropic.APITimeoutError(request=REQUEST), "api_timeout"),
        (anthropic.APIConnectionError(request=REQUEST), "api_connection"),
        (anthropic.RateLimitError("slow down", response=httpx.Response(429, request=REQUEST), body=None), "api_overload"),
        (anthropic.InternalServerError("overloaded", response=httpx.Response(529, request=REQUEST), body=None), "api_overload"),
        (anthropic.BadRequestError("bad", response=httpx.Response(400, request=REQUEST), body=None), "api_rejected"),
        (KeyError("transactions"), "schema"),
        (ValueError("Expected exactly one transaction"), "schema"),
        (RuntimeError("boom"), "other"),
    ],
)
def test_classify_failure(exc, cause):
    assert mc.classify_failure(exc) == cause


# ---- scoring helpers ------------------------------------------------------


def test_score_run_uses_evaluate_and_checks_exact_types():
    expected = GROUND_TRUTH["CASE_09"]  # three findings
    findings = [{"type": t, "finding_id": f"AF-{i}"} for i, t in enumerate(perfect("CASE_09"))]
    workpaper = {"case_id": "CASE_09", "rows": [{"finding": "x", "action": "human_review", "confidence": 0.9}],
                 "findings": findings}
    scored = mc.score_run(expected, workpaper, evaluate)
    assert scored["action_correct"] and scored["exact_types"]
    assert scored["finding_ids"] == ["AF-0", "AF-1", "AF-2"]
    workpaper["findings"] = findings[:1]
    assert not mc.score_run(expected, workpaper, evaluate)["exact_types"]
    clean = {"rows": [{"finding": "Clean", "action": "auto_clear"}], "findings": []}
    result = mc.score_run(GROUND_TRUTH["CASE_01"], clean, evaluate)
    assert result["action_correct"] and result["exact_types"] and not result["false_positive"]
    flagged = {"rows": [{"finding": "Dup", "action": "human_review"}], "findings": [{"type": "duplicate_invoice", "finding_id": "AF-x"}]}
    assert mc.score_run(GROUND_TRUTH["CASE_01"], flagged, evaluate)["false_positive"]


def test_percentile_and_stability():
    assert mc.percentile([], 95) is None
    assert mc.percentile([5, 1, 3, 2, 4], 95) == 5
    assert mc.percentile(list(range(1, 21)), 95) == 19
    assert mc.id_stability([["a"]]) is None
    assert mc.id_stability([["a", "b"], ["b", "a"], ["a"]]) == pytest.approx(2 / 3)


# ---- the run loop on the real production code path ------------------------


def test_run_loop_uses_real_pipeline_and_each_configs_models(tmp_path):
    schedule = [(1, "CASE_04", "A"), (1, "CASE_04", "B"), (1, "CASE_04", "D"), (1, "CASE_01", "C")]
    client = FakeClient(findings_for=perfect, usage=(1000, 200))
    results, stopped, path = run(schedule, client, tmp_path=tmp_path)
    assert not stopped and [r["status"] for r in results] == ["ok"] * 4
    by = {(r["config"], r["case_id"]): r for r in results}
    # five agents on a case with a finding, four on a clean case
    assert [c["agent"] for c in by[("A", "CASE_04")]["calls"]] == list(mc.AGENT_ORDER)
    assert [c["agent"] for c in by[("C", "CASE_01")]["calls"]] == ["intake", "evidence", "anomaly", "decision"]
    assert [c["model"] for c in by[("A", "CASE_04")]["calls"]] == list(mc.CONFIG_MODELS["A"].values())
    assert [c["model"] for c in by[("D", "CASE_04")]["calls"]][-2:] == ["claude-haiku-5-5"] * 2
    assert by[("B", "CASE_04")]["calls"][2]["model"] == "claude-opus-5-5"
    # effort: absent for A (exactly today's request), medium for the others
    sent = {(r["model"], "effort" in r["output_config"]) for r in client.requests[:5]}
    assert all(not has_effort for _, has_effort in sent)
    assert all(r["output_config"]["effort"] == "medium" for r in client.requests[5:])
    assert all(r["max_tokens"] == 16000 for r in client.requests)
    # perfect fake answers score as passing, and cost is the hand-computed sum
    assert all(r["action_correct"] and r["exact_types"] for r in results)
    call_cost = (1000 * 2 + 200 * 10) / 1e6  # Sonnet 5
    assert by[("A", "CASE_04")]["calls"][0]["cost_usd"] == pytest.approx(call_cost)
    assert by[("C", "CASE_01")]["cost_usd"] == pytest.approx(4 * call_cost)
    assert by[("A", "CASE_04")]["finding_ids"] and by[("A", "CASE_04")]["finding_ids"][0].startswith("AF-")
    # one JSON line per run, counts and ids only
    lines = path.read_text().splitlines()
    assert len(lines) == 4
    for line in lines:
        data = json.loads(line)
        assert set(data["calls"][0]) == {
            "agent", "model", "input_tokens", "output_tokens", "cache_read_tokens",
            "cache_write_tokens", "latency_ms", "cost_usd"}
    assert "explanation" not in path.read_text() and "reason" not in path.read_text()


def test_run_loop_records_failures_by_cause(tmp_path):
    schedule = [(1, "CASE_04", "A"), (1, "CASE_04", "D"), (1, "CASE_04", "C")]
    client = FakeClient(
        findings_for=perfect,
        failures={
            "claude-haiku-5-5": anthropic.RateLimitError(
                "slow", response=httpx.Response(429, request=REQUEST), body=None),
            "claude-sonnet-5-5": lambda kw: SimpleNamespace(content=[], stop_reason="refusal"),
        },
    )
    results, stopped, _ = run(schedule, client, tmp_path=tmp_path)
    assert [r["status"] for r in results] == ["ok", "refusal", "refusal"]
    schedule = [(1, "CASE_04", "D")]
    client = FakeClient(
        findings_for=perfect,
        failures={"claude-haiku-5-5": anthropic.RateLimitError(
            "slow", response=httpx.Response(429, request=REQUEST), body=None)},
    )
    results, _, _ = run(schedule, client, tmp_path=tmp_path)
    assert results[0]["status"] == "api_overload" and results[0]["failed_agent"] is None
    assert results[0]["action_correct"] is None


def test_refusal_names_the_failed_agent(tmp_path):
    refused = SimpleNamespace(
        content=[], stop_reason="refusal",
        usage=SimpleNamespace(input_tokens=900, output_tokens=0, cache_read_input_tokens=0, cache_creation_input_tokens=0),
    )
    client = FakeClient(failures={"claude-opus-5": lambda kw: refused})
    results, _, _ = run([(1, "CASE_04", "A")], client, tmp_path=tmp_path)
    assert results[0]["status"] == "refusal" and results[0]["failed_agent"] == "anomaly"
    assert len(results[0]["calls"]) == 3  # the refused call still cost tokens and is counted


def test_cap_stops_before_a_call_that_could_exceed_it(tmp_path):
    schedule = [(1, "CASE_04", "A"), (1, "CASE_05", "A"), (1, "CASE_06", "A")]
    client = FakeClient(findings_for=perfect)
    results, stopped, path = run(schedule, client, cap=0.30, tmp_path=tmp_path)
    assert stopped and len(results) == 1 and results[0]["status"] == "cap_stop"
    # Intake and Evidence (Sonnet worst case about $0.17) fit; Anomaly on Opus 5 (about $0.41) does not
    assert [r["model"] for r in client.requests] == ["claude-sonnet-5", "claude-sonnet-5"]
    assert results[0]["cost_usd"] < 0.30
    assert len(path.read_text().splitlines()) == 1


def test_cap_below_the_first_call_makes_no_call_at_all(tmp_path):
    client = FakeClient()
    results, stopped, _ = run([(1, "CASE_01", "A")], client, cap=0.05, tmp_path=tmp_path)
    assert stopped and client.requests == []


# ---- summaries and reports ------------------------------------------------


def _row(config, case, status="ok", action=True, exact=True, ids=("AF-1",), cost=0.01, latency=2.0, repeat=1):
    return {"config": config, "case_id": case, "repeat": repeat, "status": status, "failed_agent": None,
            "action_correct": action if status == "ok" else None, "false_positive": False if status == "ok" else None,
            "missed_exception": (not action) if status == "ok" else None,
            "exact_types": exact if status == "ok" else None, "predicted_types": [], "finding_ids": list(ids),
            "latency_s": latency, "cost_usd": cost,
            "calls": [{"agent": "intake", "model": "claude-sonnet-5", "input_tokens": 100, "output_tokens": 50,
                       "cache_read_tokens": 0, "cache_write_tokens": 0, "latency_ms": 900, "cost_usd": cost}]}


def test_summary_counts_model_failures_but_not_infrastructure_errors():
    rows = [_row("B", "CASE_01"), _row("B", "CASE_01", action=False, exact=False),
            _row("B", "CASE_01", status="refusal"), _row("B", "CASE_01", status="api_overload"),
            _row("B", "CASE_01", status="api_timeout"), _row("B", "CASE_01", status="cap_stop")]
    s = mc.summarize(rows)["by_config"]["B"]
    assert s["runs"] == 6 and s["scored_runs"] == 3          # infra and cap runs left out of the rate
    assert s["action_pass_rate"] == pytest.approx(1 / 3)     # the refusal counts as a failure
    assert s["failure_causes"] == {"refusal": 1, "api_overload": 1, "api_timeout": 1, "cap_stop": 1}
    assert s["infra_runs"] == 2


def test_id_stability_and_latency_in_the_summary():
    rows = [_row("A", "CASE_03", ids=("AF-1",), latency=1.0), _row("A", "CASE_03", ids=("AF-1",), latency=3.0),
            _row("A", "CASE_03", ids=("AF-2",), latency=2.0)]
    s = mc.summarize(rows)
    assert s["by_config"]["A"]["id_stability"] == pytest.approx(2 / 3)
    assert s["by_config"]["A"]["mean_latency_s"] == pytest.approx(2.0)
    assert s["by_config"]["A"]["p95_latency_s"] == 3.0
    assert s["by_agent"][("A", "intake")]["calls"] == 3


def test_warning_only_above_five_percent_of_runs():
    ok = [_row("A", "CASE_01") for _ in range(19)]
    one_in_twenty = mc.summarize(ok + [_row("A", "CASE_01", status="api_timeout")])
    assert mc.infra_warnings(one_in_twenty) == []                      # exactly 5%
    two_in_twenty = mc.summarize(ok[:18] + [_row("A", "CASE_01", status="api_timeout"),
                                            _row("A", "CASE_01", status="api_connection")] )
    warnings = mc.infra_warnings(two_in_twenty)
    assert len(warnings) == 1 and "config A" in warnings[0] and "api_timeout=1" in warnings[0]
    assert "api_connection=1" in warnings[0]


def test_reports_are_written_as_markdown_and_csv(tmp_path):
    summary = mc.summarize([_row("A", "CASE_01"), _row("B", "CASE_01", status="api_overload")])
    paths = mc.write_reports(tmp_path, summary, {"spend cap": "$1.00"})
    assert {p.name for p in paths} == {"report.md", "summary_by_config.csv", "summary_by_case.csv", "summary_by_agent.csv"}
    text = (tmp_path / "report.md").read_text()
    assert "| A |" in text and "api_overload=1" in text and "spend cap" in text
    header, *rows = (tmp_path / "summary_by_config.csv").read_text().splitlines()
    assert header.startswith("config,runs") and len(rows) == 2


# ---- command line ---------------------------------------------------------


def test_dry_run_prints_the_plan_and_creates_no_client(monkeypatch, capsys):
    def no_client(*a, **k):
        raise AssertionError("a client must not be created in a dry run")

    monkeypatch.setattr(anthropic, "Anthropic", no_client)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert mc.main(["--configs", "A,B,C,D", "--repeats", "3", "--cap-usd", "12"]) == 0
    out = capsys.readouterr().out
    assert "Pipeline runs: 168" in out and "Estimated model calls: 816" in out
    assert "DRY RUN" in out and "Nothing was run" in out and "run_full_pipeline" in out
    for config in "ABCD":
        assert re.search(rf"^  {config}: \$[\d,.]+ ", out, re.M)


def test_run_needs_a_cap_and_a_key_and_never_prints_the_key(monkeypatch, capsys):
    monkeypatch.setattr(anthropic, "Anthropic", lambda *a, **k: pytest.fail("no client expected"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert mc.main(["--run", "--cap-usd", "1"]) == 2
    assert "ANTHROPIC_API_KEY is not set" in capsys.readouterr().err
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-sentinel-do-not-print")
    assert mc.main(["--run"]) == 2
    captured = capsys.readouterr()
    assert "--cap-usd" in captured.err
    assert "sentinel" not in captured.out + captured.err


def test_smoke_runs_one_case_once_with_the_fifty_cent_cap(monkeypatch, capsys, tmp_path):
    client = FakeClient(findings_for=perfect, usage=(1500, 300))
    made = []
    monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: made.append(kw) or client)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-sentinel-do-not-print")
    assert mc.main(["--smoke", "--run", "--cap-usd", "99", "--out", str(tmp_path)]) == 0
    out = capsys.readouterr()
    assert made == [{"max_retries": 0}]
    assert len(client.requests) == 5                       # CASE_04, five agents, one config, one run
    assert "Pipeline runs: 1" in out.out and "Cap: $0.50" in out.out and "SMOKE" in out.out
    assert "Console" in out.out and "run_full_pipeline" in out.out
    assert "sentinel" not in out.out + out.err
    (run_dir,) = list(tmp_path.iterdir())
    assert {p.name for p in run_dir.iterdir()} >= {"runs.jsonl", "report.md", "summary_by_config.csv"}


def test_unknown_config_or_case_is_refused(capsys):
    assert mc.main(["--configs", "A,Z"]) == 2
    assert mc.main(["--cases", "CASE_99"]) == 2
