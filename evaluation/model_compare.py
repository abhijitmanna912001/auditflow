"""Compare Claude model configurations on the 14-case benchmark.

NOT part of the app. Nothing happens at import; everything runs from main()
under __main__. By default this prints only a dry run (the number of
pipeline runs, estimated model calls and estimated cost) and makes no model
call. A live run needs the explicit --run flag and ANTHROPIC_API_KEY in the
environment (never printed). CI only compiles this file.

    python evaluation/model_compare.py --configs A,B,C,D --repeats 3 --cap-usd 12
    python evaluation/model_compare.py --configs A,B,C,D --repeats 3 --cap-usd 12 --run
    python evaluation/model_compare.py --smoke --run        # 1 case, 1 run, $0.50 cap

Configurations (docs: scratch/model-test-design.md):
    A  today's models, no effort set (the API default applies)
    B  Sonnet 5.5 for Intake/Evidence/Decision/Workpaper, Opus 5.5 for Anomaly
    C  Sonnet 5.5 for all five agents
    D  Sonnet 5.5 for Intake/Evidence/Anomaly, Haiku 5.5 for Decision/Workpaper
B, C and D send the same explicit effort (--effort, default medium, never max).

Each run calls the real production code path, workpaper_agent.run_full_pipeline
(what POST /run-case calls), through model_config.use_config and
usage_log.create_message, so prompts, schemas and parsing are the app's own.
The only difference from production: the client is created with max_retries=0
so every billed attempt is visible. Scoring uses evaluation/evaluate.py's own
load_ground_truth and score_case.

Spend cap: before every model call a worst-case cost (estimated input tokens
plus max_tokens of output, at that model's price) is added to the spend so far;
if that would pass the cap the call is not made and the run stops.

Results (counts, types and ids only, never document text) go to a git-ignored
folder: runs.jsonl, report.md and three CSV files.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import json
import math
import os
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "evaluation" / "model_compare_runs"
AGENT_ORDER = ("intake", "evidence", "anomaly", "decision", "workpaper")

CODE_PATH = (
    "workpaper_agent.run_full_pipeline(case_folder) - the function POST /run-case calls - "
    "through model_config.use_config and usage_log.create_message"
)

SMOKE_CAP_USD = 0.50
SMOKE_CASE = "CASE_04"  # has a finding, so all five agents are called
DEFAULT_PASS1_CAP_USD = 12.0
INFRA_WARNING_FRACTION = 0.05

# ---- configurations -------------------------------------------------------

_TODAY = {
    "intake": "claude-sonnet-5",
    "evidence": "claude-sonnet-5",
    "anomaly": "claude-opus-5",
    "decision": "claude-sonnet-5",
    "workpaper": "claude-sonnet-5",
}
_S55, _O55, _H55 = "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"
CONFIG_MODELS = {
    "A": dict(_TODAY),
    "B": {"intake": _S55, "evidence": _S55, "anomaly": _O55, "decision": _S55, "workpaper": _S55},
    "C": {a: _S55 for a in AGENT_ORDER},
    "D": {"intake": _S55, "evidence": _S55, "anomaly": _S55, "decision": _H55, "workpaper": _H55},
}
EFFORT_CHOICES = ("low", "medium", "high", "xhigh")  # "max" is deliberately not offered


def config_effort(name: str, effort: str) -> str | None:
    """A is exactly today's request (no effort); the others send `effort`."""
    return None if name == "A" else effort


def config_description(name: str, effort: str) -> str:
    eff = config_effort(name, effort)
    shown = f"effort {eff}" if eff else "effort not set (API default; the docs say high for Sonnet 5 and Opus 5)"
    models = ", ".join(f"{a}={CONFIG_MODELS[name][a]}" for a in AGENT_ORDER)
    return f"{name}: {models}; {shown}"


def config_settings(name: str, effort: str) -> dict:
    """{agent: model_config.Settings} for use_config."""
    _prepare_paths()
    from model_config import DEFAULT_MAX_TOKENS, Settings

    eff = config_effort(name, effort)
    return {a: Settings(CONFIG_MODELS[name][a], DEFAULT_MAX_TOKENS, eff) for a in AGENT_ORDER}


# ---- schedule -------------------------------------------------------------


def build_schedule(cases: list[str], configs: list[str], repeats: int, seed: int) -> list[tuple[int, str, str]]:
    """(repeat, case, config) in run order. For each repeat and case the
    configs are shuffled (seeded), so no config always runs first or last and
    time of day does not favour one."""
    rng = random.Random(seed)
    schedule = []
    for repeat in range(1, repeats + 1):
        for case in cases:
            order = list(configs)
            rng.shuffle(order)
            schedule.extend((repeat, case, config) for config in order)
    return schedule


# ---- token and cost estimates --------------------------------------------

CHARS_PER_TOKEN_ESTIMATE = 3.0   # dry-run estimate
CHARS_PER_TOKEN_RESERVE = 2.5    # cap guard: deliberately pessimistic
NON_TEXT_BLOCK_TOKENS = 6000     # PDF/image blocks in the guard (pass 3 only)

# ASSUMPTIONS, not measurements: tokens per call before any real run. The
# dry run uses the real system prompts and fixture text for Intake input; the
# rest are guesses. Replace with measured averages via --assumed-tokens FILE
# ({"anomaly": {"input": 2500, "output": 600}, ...}) after --smoke or pass 1.
ASSUMED_USER_INPUT_TOKENS = {"intake": None, "evidence": 900, "anomaly": 1800, "decision": 500, "workpaper": 400}
ASSUMED_SCHEMA_TOKENS = 500
ASSUMED_VISIBLE_OUTPUT_TOKENS = {"intake": 700, "evidence": 400, "anomaly": 500, "decision": 120, "workpaper": 80}
ASSUMED_THINKING_OUTPUT_TOKENS = 1000  # unknown; thinking is billed as output


def estimate_input_tokens(system, messages, output_config=None) -> int:
    """Pessimistic input-token estimate for the cap guard (characters / 2.5,
    rounded up, plus a fixed allowance per non-text block)."""
    chars = len(system) if isinstance(system, str) else 0
    extra_tokens = 0
    for message in messages or []:
        content = message.get("content")
        if isinstance(content, str):
            chars += len(content)
        else:
            for block in content or []:
                if block.get("type") == "text":
                    chars += len(block.get("text", ""))
                else:
                    extra_tokens += NON_TEXT_BLOCK_TOKENS
    if output_config:
        chars += len(json.dumps(output_config))
    return math.ceil(chars / CHARS_PER_TOKEN_RESERVE) + extra_tokens


def worst_case_cost(model: str, input_tokens: int, max_tokens: int) -> float:
    """Dollars if the call used `input_tokens` of input and all `max_tokens`
    of output (no cache use)."""
    _prepare_paths()
    from price_table import estimate_cost

    return estimate_cost(model, input_tokens, max_tokens)


class SpendCapExceeded(Exception):
    """The next model call could push the spend past the cap."""


class SpendGuard:
    """usage_log.pre_call_guard callback. `records` is the list filled by
    usage_log.collect_usage(); spend so far is priced from it."""

    def __init__(self, cap_usd: float, records: list):
        self.cap_usd = cap_usd
        self.records = records

    def spent(self) -> float:
        _prepare_paths()
        from price_table import estimate_cost

        return sum(
            estimate_cost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens)
            for r in self.records
        )

    def __call__(self, agent: str, params: dict, kwargs: dict) -> None:
        est_input = estimate_input_tokens(kwargs.get("system"), kwargs.get("messages"), params.get("output_config"))
        reservation = worst_case_cost(params["model"], est_input, params["max_tokens"])
        spent = self.spent()
        if spent + reservation > self.cap_usd:
            raise SpendCapExceeded(
                f"cap ${self.cap_usd:.2f}: spent ${spent:.4f} + worst case ${reservation:.4f} for the next {agent} call"
            )


def load_assumed_tokens(path: str | None) -> dict:
    """Per-agent {"input": N, "output": M} overrides from a JSON file."""
    if not path:
        return {}
    with open(path) as f:
        data = json.load(f)
    return {a: v for a, v in data.items() if a in AGENT_ORDER}


def assumed_calls(case_id: str, has_findings: bool, dataset_dir: Path, overrides: dict | None = None) -> list[tuple[str, int, int]]:
    """[(agent, input_tokens, output_tokens)] the pipeline is expected to make
    for one case: four calls, plus Workpaper when the case has findings."""
    _prepare_paths()
    import anomaly_agent, decision_agent, evidence_agent, intake_agent, workpaper_agent

    prompts = {
        "intake": intake_agent.SYSTEM_PROMPT,
        "evidence": evidence_agent.SYSTEM_PROMPT,
        "anomaly": anomaly_agent.SYSTEM_PROMPT,
        "decision": decision_agent.SYSTEM_PROMPT,
        "workpaper": workpaper_agent.SYSTEM_PROMPT,
    }
    overrides = overrides or {}
    fixture_chars = sum(len(p.read_text(errors="ignore")) for p in (dataset_dir / case_id).glob("*.txt"))
    calls = []
    for agent in AGENT_ORDER:
        if agent == "workpaper" and not has_findings:
            continue
        if agent in overrides:
            calls.append((agent, int(overrides[agent]["input"]), int(overrides[agent]["output"])))
            continue
        user_tokens = (
            math.ceil(fixture_chars / CHARS_PER_TOKEN_ESTIMATE)
            if agent == "intake" else ASSUMED_USER_INPUT_TOKENS[agent]
        )
        in_tokens = math.ceil(len(prompts[agent]) / CHARS_PER_TOKEN_ESTIMATE) + user_tokens + ASSUMED_SCHEMA_TOKENS
        out_tokens = ASSUMED_VISIBLE_OUTPUT_TOKENS[agent] + ASSUMED_THINKING_OUTPUT_TOKENS
        calls.append((agent, in_tokens, out_tokens))
    return calls


def dry_run_text(ground_truth: dict, cases: list[str], configs: list[str], repeats: int, cap_usd: float,
                 effort: str, dataset_dir: Path, overrides: dict | None = None) -> str:
    """The plan and rough cost. Makes no model call and needs no API key."""
    _prepare_paths()
    from price_table import CHECKED_ON, SOURCE_URL, estimate_cost

    per_case = {c: assumed_calls(c, bool(ground_truth[c]["expected_findings"]), dataset_dir, overrides) for c in cases}
    calls_per_pass = sum(len(v) for v in per_case.values())
    runs = len(cases) * len(configs) * repeats
    lines = [
        "DRY RUN - no model call is made and no API key is needed.",
        "",
        f"Cases: {len(cases)}   Configs: {','.join(configs)}   Repeats: {repeats}   Cap: ${cap_usd:.2f}",
        f"Pipeline runs: {runs}",
        f"Estimated model calls: {calls_per_pass * len(configs) * repeats} "
        f"({calls_per_pass} per config per repeat: 4 calls per case, 5 when the case has findings)",
        f"Code path a live run would use: {CODE_PATH}",
        "Client: anthropic.Anthropic(max_retries=0) (production default is 2 retries)",
        "",
        "Configurations:",
    ]
    lines += [f"  {config_description(c, effort)}" for c in configs]
    lines += ["", f"Estimated cost per config (prices from agents/price_table.py, checked {CHECKED_ON}, {SOURCE_URL}):"]
    total = 0.0
    worst = {}
    for c in configs:
        cost = 0.0
        for repeat_calls in per_case.values():
            for agent, tin, tout in repeat_calls:
                model = CONFIG_MODELS[c][agent]
                cost += estimate_cost(model, tin, tout)
                worst[model] = max(worst.get(model, 0.0), worst_case_cost(model, tin, 16000))
        cost *= repeats
        total += cost
        lines.append(f"  {c}: ${cost:,.2f}  (${cost / (len(cases) * repeats):.4f} per pipeline run)")
    lines.append(f"  total: ${total:,.2f} against a cap of ${cap_usd:,.2f}" + ("  <-- ABOVE THE CAP" if total > cap_usd else ""))
    lines += [
        "",
        "These costs come from ASSUMED token counts (real system prompts and fixture text for Intake input; guesses for",
        f"the rest, including {ASSUMED_THINKING_OUTPUT_TOKENS} thinking tokens per call). Treat them as order of magnitude, then run --smoke",
        "and pass --assumed-tokens with measured averages. Thinking volume at the chosen effort is unknown until measured.",
        "",
        "Worst-case reservation per call (input estimate + 16000 output tokens); the run can stop up to one call early:",
    ]
    lines += [f"  {m}: up to ${v:.3f}" for m, v in sorted(worst.items())]
    return "\n".join(lines)


# ---- failures and scoring -------------------------------------------------

INFRA_CAUSES = ("api_overload", "api_timeout", "api_connection")
EXCLUDED_CAUSES = INFRA_CAUSES + ("cap_stop",)  # not a model failure: left out of pass-rate denominators


def classify_failure(exc: BaseException) -> str:
    """One cause per failed run: refusal, truncated, no_text, parse (from
    ModelResponseError), schema (any other problem handling the response),
    api_overload / api_timeout / api_connection (infrastructure),
    api_rejected (the API refused the request, e.g. 400), cap_stop, other."""
    _prepare_paths()
    import anthropic
    from model_response import ModelResponseError

    if isinstance(exc, SpendCapExceeded):
        return "cap_stop"
    if isinstance(exc, ModelResponseError):
        return exc.cause
    if isinstance(exc, anthropic.APITimeoutError):
        return "api_timeout"
    if isinstance(exc, anthropic.APIConnectionError):
        return "api_connection"
    if isinstance(exc, anthropic.APIStatusError):
        status = getattr(exc, "status_code", 0)
        return "api_overload" if status == 429 or status >= 500 else "api_rejected"
    if isinstance(exc, (ValueError, KeyError, TypeError, IndexError, StopIteration, AttributeError)):
        return "schema"
    return "other"


def score_run(expected: dict, workpaper: dict, evaluate) -> dict:
    """Score one finished pipeline run. `evaluate` is evaluation/evaluate.py
    (its score_case is the scorer the README's accuracy comes from)."""
    scored = evaluate.score_case(expected, workpaper)
    findings = workpaper.get("findings", [])
    predicted_types = sorted({f["type"] for f in findings})
    expected_types = {f["type"] for f in expected.get("expected_findings", [])}
    return {
        "action_correct": bool(scored["action_correct"]),
        "false_positive": bool(scored["false_positive"]),
        "missed_exception": bool(scored["missed_exception"]),
        "exact_types": set(predicted_types) == expected_types,
        "predicted_types": predicted_types,
        "finding_ids": sorted(f["finding_id"] for f in findings),
    }


def percentile(values: list[float], pct: float) -> float | None:
    """Nearest-rank percentile; None for an empty list."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[rank - 1]


def id_stability(id_sets: list[list[str]]) -> float | None:
    """Share of repeats whose finding-id set equals the most common set;
    None with fewer than two runs."""
    if len(id_sets) < 2:
        return None
    counts = Counter(tuple(sorted(s)) for s in id_sets)
    return counts.most_common(1)[0][1] / len(id_sets)


# ---- running --------------------------------------------------------------


def run_benchmark(schedule, ground_truth, dataset_dir, client, evaluate, cap_usd, effort, results_path,
                  pipeline=None, progress=print) -> tuple[list[dict], bool]:
    """Run the schedule serially. Returns (results, stopped_by_cap). Each
    finished run is appended to results_path (JSON lines) straight away."""
    _prepare_paths()
    from model_config import use_config
    from price_table import estimate_cost
    from usage_log import collect_usage, pre_call_guard

    if pipeline is None:
        from workpaper_agent import run_full_pipeline

        def pipeline(case_folder, client):
            return run_full_pipeline(
                case_folder,
                intake_client=client, evidence_client=client, anomaly_client=client,
                decision_client=client, workpaper_client=client,
            )

    results: list[dict] = []
    stopped = False
    with collect_usage() as records, pre_call_guard(SpendGuard(cap_usd, records)):
        for number, (repeat, case_id, config) in enumerate(schedule, start=1):
            first_record = len(records)
            started = time.perf_counter()
            row = {"config": config, "case_id": case_id, "repeat": repeat, "failed_agent": None}
            try:
                with use_config(config_settings(config, effort)):
                    workpaper = pipeline(str(dataset_dir / case_id) + "/", client)
                row.update(status="ok", **score_run(ground_truth[case_id], workpaper, evaluate))
            except Exception as exc:  # every failure becomes a recorded cause
                row.update(
                    status=classify_failure(exc), failed_agent=getattr(exc, "agent", None),
                    action_correct=None, false_positive=None, missed_exception=None,
                    exact_types=None, predicted_types=[], finding_ids=[],
                )
            row["latency_s"] = round(time.perf_counter() - started, 3)
            calls = []
            for r in records[first_record:]:
                call = asdict(r)
                call["cost_usd"] = estimate_cost(
                    r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens
                )
                calls.append(call)
            row["calls"] = calls
            row["cost_usd"] = round(sum(c["cost_usd"] for c in calls), 6)
            results.append(row)
            with open(results_path, "a") as f:
                f.write(json.dumps(row) + "\n")
            spent = sum(r["cost_usd"] for r in results)
            progress(
                f"[{number}/{len(schedule)}] {case_id} {config} repeat {repeat}: {row['status']}"
                f" action_correct={row['action_correct']} run_cost=${row['cost_usd']:.4f} spent=${spent:.4f}"
            )
            if row["status"] == "cap_stop":
                stopped = True
                break
    return results, stopped


# ---- summaries ------------------------------------------------------------


def _scored(rows):
    return [r for r in rows if r["status"] not in EXCLUDED_CAUSES]


def _rate(numerator, denominator):
    return numerator / denominator if denominator else None


def summarize(results: list[dict]) -> dict:
    """by_config, by_case, by_agent aggregates. Failed model runs count as
    failures in rates; infrastructure errors and cap stops are left out of the
    denominators and counted separately."""
    by_config: dict = {}
    by_case: dict = {}
    for config in sorted({r["config"] for r in results}):
        rows = [r for r in results if r["config"] == config]
        scored = _scored(rows)
        ok = [r for r in rows if r["status"] == "ok"]
        causes = Counter(r["status"] for r in rows if r["status"] != "ok")
        stability_pairs = []
        for case_id in sorted({r["case_id"] for r in ok}):
            sets = [r["finding_ids"] for r in ok if r["case_id"] == case_id]
            s = id_stability(sets)
            if s is not None:
                stability_pairs.append((s * len(sets), len(sets)))
        calls = [c for r in rows for c in r["calls"]]
        by_config[config] = {
            "runs": len(rows),
            "scored_runs": len(scored),
            "action_pass_rate": _rate(sum(1 for r in scored if r["action_correct"]), len(scored)),
            "exact_type_rate": _rate(sum(1 for r in scored if r["exact_types"]), len(scored)),
            "id_stability": _rate(sum(a for a, _ in stability_pairs), sum(b for _, b in stability_pairs)),
            "false_positives": sum(1 for r in ok if r["false_positive"]),
            "missed_exceptions": sum(1 for r in ok if r["missed_exception"]),
            "failure_causes": dict(causes),
            "infra_runs": sum(causes.get(c, 0) for c in INFRA_CAUSES),
            "infra_fraction": _rate(sum(causes.get(c, 0) for c in INFRA_CAUSES), len(rows)),
            "total_cost_usd": sum(r["cost_usd"] for r in rows),
            "mean_cost_usd": _rate(sum(r["cost_usd"] for r in rows), len(rows)),
            "mean_latency_s": statistics.mean([r["latency_s"] for r in ok]) if ok else None,
            "p95_latency_s": percentile([r["latency_s"] for r in ok], 95),
            "input_tokens": sum(c["input_tokens"] for c in calls),
            "output_tokens": sum(c["output_tokens"] for c in calls),
            "cache_read_tokens": sum(c["cache_read_tokens"] for c in calls),
            "cache_write_tokens": sum(c["cache_write_tokens"] for c in calls),
        }
        for case_id in sorted({r["case_id"] for r in rows}):
            case_rows = [r for r in rows if r["case_id"] == case_id]
            case_scored = _scored(case_rows)
            case_ok = [r for r in case_rows if r["status"] == "ok"]
            case_calls = [c for r in case_rows for c in r["calls"]]
            by_case[(config, case_id)] = {
                "runs": len(case_rows),
                "scored_runs": len(case_scored),
                "action_pass_rate": _rate(sum(1 for r in case_scored if r["action_correct"]), len(case_scored)),
                "exact_type_rate": _rate(sum(1 for r in case_scored if r["exact_types"]), len(case_scored)),
                "id_stability": id_stability([r["finding_ids"] for r in case_ok]),
                "failures": sum(1 for r in case_rows if r["status"] != "ok"),
                "mean_cost_usd": _rate(sum(r["cost_usd"] for r in case_rows), len(case_rows)),
                "mean_latency_s": statistics.mean([r["latency_s"] for r in case_ok]) if case_ok else None,
                "input_tokens": sum(c["input_tokens"] for c in case_calls),
                "output_tokens": sum(c["output_tokens"] for c in case_calls),
            }
    by_agent: dict = {}
    for config in by_config:
        grouped = defaultdict(list)
        for r in results:
            if r["config"] == config:
                for c in r["calls"]:
                    grouped[(c["agent"], c["model"])].append(c)
        for (agent, model), calls in sorted(grouped.items(), key=lambda kv: (AGENT_ORDER.index(kv[0][0]) if kv[0][0] in AGENT_ORDER else 99, kv[0][1])):
            by_agent[(config, agent)] = {
                "model": model,
                "calls": len(calls),
                "input_tokens": sum(c["input_tokens"] for c in calls),
                "output_tokens": sum(c["output_tokens"] for c in calls),
                "cache_read_tokens": sum(c["cache_read_tokens"] for c in calls),
                "cache_write_tokens": sum(c["cache_write_tokens"] for c in calls),
                "cost_usd": sum(c["cost_usd"] for c in calls),
                "mean_latency_ms": statistics.mean([c["latency_ms"] for c in calls]),
                "p95_latency_ms": percentile([c["latency_ms"] for c in calls], 95),
            }
    return {"by_config": by_config, "by_case": by_case, "by_agent": by_agent}


def infra_warnings(summary: dict) -> list[str]:
    warnings = []
    for config, s in summary["by_config"].items():
        fraction = s["infra_fraction"]
        if fraction is not None and fraction > INFRA_WARNING_FRACTION:
            counts = ", ".join(f"{c}={s['failure_causes'].get(c, 0)}" for c in INFRA_CAUSES)
            warnings.append(
                f"WARNING: config {config}: {s['infra_runs']} of {s['runs']} runs ({fraction:.0%}) hit API "
                f"overload, timeout or connection errors ({counts}); its rates rest on fewer runs."
            )
    return warnings


def _pct(x):
    return "n/a" if x is None else f"{x:.0%}"


def _num(x, digits=2):
    return "n/a" if x is None else f"{x:.{digits}f}"


def report_markdown(summary: dict, run_info: dict) -> str:
    lines = ["# Model comparison report", ""]
    for key, value in run_info.items():
        lines.append(f"- **{key}**: {value}")
    lines += ["", "## Per configuration", "",
              "Gate: action pass rate. Tie-breakers: exact finding-type match, then finding-id stability. "
              "Failed model runs count as failures; API overload/timeout/connection runs and cap stops are left "
              "out of the rates and shown separately.", "",
              "| Config | Runs | Scored | Action pass | Exact types | Id stability | False pos. | Missed | Cost $ | $/run | Latency mean s | p95 s |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for c, s in summary["by_config"].items():
        lines.append(
            f"| {c} | {s['runs']} | {s['scored_runs']} | {_pct(s['action_pass_rate'])} | {_pct(s['exact_type_rate'])} | "
            f"{_pct(s['id_stability'])} | {s['false_positives']} | {s['missed_exceptions']} | {s['total_cost_usd']:.4f} | "
            f"{_num(s['mean_cost_usd'], 4)} | {_num(s['mean_latency_s'])} | {_num(s['p95_latency_s'])} |"
        )
    lines += ["", "## Failure causes per configuration", "",
              "| Config | Causes (count) | Infrastructure runs (overload/timeout/connection) |", "|---|---|---|"]
    for c, s in summary["by_config"].items():
        causes = ", ".join(f"{k}={v}" for k, v in sorted(s["failure_causes"].items())) or "none"
        lines.append(f"| {c} | {causes} | {s['infra_runs']} of {s['runs']} ({_pct(s['infra_fraction'])}) |")
    warnings = infra_warnings(summary)
    if warnings:
        lines += [""] + [f"**{w}**" for w in warnings]
    lines += ["", "## Per case and configuration", "",
              "| Case | Config | Runs | Action pass | Exact types | Id stability | Failures | $/run | Latency s | Input tok | Output tok |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for (c, case_id), s in sorted(summary["by_case"].items(), key=lambda kv: (kv[0][1], kv[0][0])):
        lines.append(
            f"| {case_id} | {c} | {s['runs']} | {_pct(s['action_pass_rate'])} | {_pct(s['exact_type_rate'])} | "
            f"{_pct(s['id_stability'])} | {s['failures']} | {_num(s['mean_cost_usd'], 4)} | {_num(s['mean_latency_s'])} | "
            f"{s['input_tokens']} | {s['output_tokens']} |"
        )
    lines += ["", "## Per agent and configuration", "",
              "| Config | Agent | Model | Calls | Input tok | Output tok | Cache read | Cache write | Cost $ | Latency mean ms | p95 ms |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for (c, agent), s in summary["by_agent"].items():
        lines.append(
            f"| {c} | {agent} | {s['model']} | {s['calls']} | {s['input_tokens']} | {s['output_tokens']} | "
            f"{s['cache_read_tokens']} | {s['cache_write_tokens']} | {s['cost_usd']:.4f} | "
            f"{_num(s['mean_latency_ms'], 0)} | {_num(s['p95_latency_ms'], 0)} |"
        )
    return "\n".join(lines) + "\n"


def _write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def write_reports(out_dir: Path, summary: dict, run_info: dict) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.md").write_text(report_markdown(summary, run_info))
    config_cols = ["runs", "scored_runs", "action_pass_rate", "exact_type_rate", "id_stability", "false_positives",
                   "missed_exceptions", "infra_runs", "infra_fraction", "total_cost_usd", "mean_cost_usd",
                   "mean_latency_s", "p95_latency_s", "input_tokens", "output_tokens", "cache_read_tokens",
                   "cache_write_tokens"]
    _write_csv(out_dir / "summary_by_config.csv", ["config"] + config_cols + ["failure_causes"],
               [[c] + [s[k] for k in config_cols] + [json.dumps(s["failure_causes"], sort_keys=True)]
                for c, s in summary["by_config"].items()])
    case_cols = ["runs", "scored_runs", "action_pass_rate", "exact_type_rate", "id_stability", "failures",
                 "mean_cost_usd", "mean_latency_s", "input_tokens", "output_tokens"]
    _write_csv(out_dir / "summary_by_case.csv", ["config", "case_id"] + case_cols,
               [[c, case_id] + [s[k] for k in case_cols]
                for (c, case_id), s in sorted(summary["by_case"].items(), key=lambda kv: (kv[0][1], kv[0][0]))])
    agent_cols = ["model", "calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                  "cost_usd", "mean_latency_ms", "p95_latency_ms"]
    _write_csv(out_dir / "summary_by_agent.csv", ["config", "agent"] + agent_cols,
               [[c, agent] + [s[k] for k in agent_cols] for (c, agent), s in summary["by_agent"].items()])
    return [out_dir / n for n in ("report.md", "summary_by_config.csv", "summary_by_case.csv", "summary_by_agent.csv")]


# ---- command line ---------------------------------------------------------


def _prepare_paths() -> None:
    """Make agents/ and evaluation/ importable. Called from functions only,
    never at import."""
    for p in (REPO_ROOT / "agents", REPO_ROOT / "evaluation"):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--configs", default="A,B,C,D", help="comma list of A,B,C,D (default all)")
    parser.add_argument("--repeats", type=int, default=3, help="runs per case per config (default 3)")
    parser.add_argument("--cap-usd", type=float, default=None,
                        help=f"hard spend cap in dollars (required with --run; dry run shows ${DEFAULT_PASS1_CAP_USD:.0f} if omitted)")
    parser.add_argument("--effort", default="medium", choices=EFFORT_CHOICES,
                        help="effort for B, C and D (A sends none); default medium; max is not offered")
    parser.add_argument("--cases", default=None, help="comma list such as CASE_04,CASE_09 (default all)")
    parser.add_argument("--seed", type=int, default=1, help="seed for the interleaving order")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="folder for results (git-ignored by default)")
    parser.add_argument("--dataset", default=str(REPO_ROOT / "dataset"))
    parser.add_argument("--assumed-tokens", default=None, help="JSON file of measured per-agent tokens for the estimate")
    parser.add_argument("--smoke", action="store_true",
                        help=f"one case ({SMOKE_CASE}) once under the first config with a ${SMOKE_CAP_USD:.2f} cap, "
                             "to calibrate against the Console (still needs --run)")
    parser.add_argument("--run", action="store_true", help="make real model calls (needs ANTHROPIC_API_KEY)")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    configs = [c.strip().upper() for c in args.configs.split(",") if c.strip()]
    bad = [c for c in configs if c not in CONFIG_MODELS]
    if bad or not configs:
        print(f"Unknown config(s): {bad or 'none given'}; choose from {sorted(CONFIG_MODELS)}", file=sys.stderr)
        return 2
    if args.repeats < 1:
        print("--repeats must be at least 1", file=sys.stderr)
        return 2

    _prepare_paths()
    import evaluate

    dataset_dir = Path(args.dataset)
    ground_truth = evaluate.load_ground_truth(str(dataset_dir))
    cases = [c.strip() for c in args.cases.split(",")] if args.cases else sorted(ground_truth)
    unknown = [c for c in cases if c not in ground_truth]
    if unknown:
        print(f"Unknown case(s): {unknown}", file=sys.stderr)
        return 2

    repeats, cap = args.repeats, args.cap_usd
    if args.smoke:
        configs, repeats, cap = configs[:1], 1, SMOKE_CAP_USD
        cases = [cases[0]] if args.cases else [SMOKE_CASE]
    shown_cap = cap if cap is not None else DEFAULT_PASS1_CAP_USD

    overrides = load_assumed_tokens(args.assumed_tokens)
    print(dry_run_text(ground_truth, cases, configs, repeats, shown_cap, args.effort, dataset_dir, overrides))
    if not args.run:
        print("\nNothing was run. Add --run (and --cap-usd) to make real model calls.")
        return 0

    if cap is None:
        print("--run needs an explicit --cap-usd.", file=sys.stderr)
        return 2
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set in the environment.", file=sys.stderr)
        return 2

    import logging

    import anthropic

    logging.getLogger("auditflow.usage").setLevel(logging.WARNING)  # this script reports its own progress
    client = anthropic.Anthropic(max_retries=0)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.out) / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "runs.jsonl"
    schedule = build_schedule(cases, configs, repeats, args.seed)
    print(f"\nLIVE RUN: {len(schedule)} pipeline runs, cap ${cap:.2f}, results in {out_dir}")
    print(f"Code path: {CODE_PATH}")

    results, stopped = run_benchmark(schedule, ground_truth, dataset_dir, client, evaluate, cap, args.effort, results_path)

    run_info = {
        "date (UTC)": stamp,
        "code path": CODE_PATH,
        "configs": "; ".join(config_description(c, args.effort) for c in configs),
        "repeats": repeats,
        "cases": len(cases),
        "seed": args.seed,
        "spend cap": f"${cap:.2f}",
        "estimated spend": f"${sum(r['cost_usd'] for r in results):.4f} (from response usage and agents/price_table.py)",
        "completed": f"{len(results)} of {len(schedule)} runs" + (" - STOPPED BY THE SPEND CAP" if stopped else ""),
    }
    summary = summarize(results)
    paths = write_reports(out_dir, summary, run_info)
    print("\nWrote:\n" + "\n".join(f"  {p}" for p in paths + [results_path]))
    for warning in infra_warnings(summary):
        print(warning)
    if args.smoke:
        spent = sum(r["cost_usd"] for r in results)
        print(f"\nSMOKE: estimated cost ${spent:.4f}. Compare with the Console's usage and cost for this API key "
              "over the same minutes; the two should agree closely.")
        for (c, agent), s in summary["by_agent"].items():
            print(f"  {agent}: {s['model']} in={s['input_tokens']} out={s['output_tokens']} ${s['cost_usd']:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
