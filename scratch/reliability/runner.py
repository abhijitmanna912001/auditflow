"""Stage-by-stage reliability runner. Does not modify agents/evaluation code."""
import json, sys, os, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT = Path(os.environ.get("AUDITFLOW_ROOT") or Path(__file__).resolve().parents[2])
HERE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents")); sys.path.insert(0, str(ROOT / "evaluation"))
import intake_agent, evidence_agent, anomaly_agent, decision_agent
import evaluate  # reused: load_ground_truth / scoring semantics
OUT = HERE / "scratch" / "reliability"

def run_stages(case_id, tag):
    d = OUT / "runs" / case_id / tag; d.mkdir(parents=True, exist_ok=True)
    def save(n, o): (d / f"{n}.json").write_text(json.dumps(o, indent=2))
    intake = intake_agent.run_intake_agent(str(ROOT / "dataset" / case_id) + "/"); save("intake", intake)
    ev = evidence_agent.run_evidence_agent(intake); save("evidence", ev)
    (d / "anomaly_input.txt").write_text(anomaly_agent._build_user_message(ev, intake))
    an = anomaly_agent.run_anomaly_agent(ev, intake); save("anomaly", an)
    dec = decision_agent.run_decision_agent(an); save("decision", dec)
    return {"intake": intake, "evidence": ev, "anomaly": an, "decision": dec,
            "anomaly_input": (d / "anomaly_input.txt").read_text()}

def score(gt, r):
    exp_types = {f["type"] for f in gt["expected_findings"]}
    got_types = {f.get("type") for f in r["anomaly"]["findings"] if f.get("type")}
    # same set-based per-case logic as evaluate.score_finding_types
    return {"types_match": exp_types == got_types, "extra": sorted(got_types - exp_types),
            "missing": sorted(exp_types - got_types),
            "action_match": r["decision"]["action"] == gt["expected_action"],
            "action": r["decision"]["action"], "got_types": sorted(got_types)}

if __name__ == "__main__":
    mode = sys.argv[1]
    gts = evaluate.load_ground_truth(str(ROOT / "dataset"))
    jobs = []
    if mode == "probe":
        jobs = [("CASE_14", "probe")]
    elif mode == "case":  # case n
        jobs = [(sys.argv[2], f"run{i:02d}") for i in range(int(sys.argv[3]))]
    elif mode == "tagged":  # tagged case n prefix
        jobs = [(sys.argv[2], f"{sys.argv[4]}{i:02d}") for i in range(int(sys.argv[3]))]
    elif mode == "bench":
        jobs = [(c, f"bench{i}") for i in range(3) for c in sorted(gts)]
    def go(j):
        c, t = j
        try:
            r = run_stages(c, t); s = score(gts[c], r); s.update(case=c, tag=t)
            return s
        except Exception as e:
            return {"case": c, "tag": t, "error": f"{type(e).__name__}: {str(e)[:300]}"}
    first = go(jobs[0]); print(first)
    if "error" in first and ("401" in first["error"] or "uthentication" in first["error"]):
        print("401 - STOP"); sys.exit(2)
    with ThreadPoolExecutor(4) as ex: rest = list(ex.map(go, jobs[1:]))
    res = [first] + rest
    (OUT / f"results_{mode}_{jobs[0][0] if mode in ('case','tagged') else ''}{sys.argv[4] if mode=='tagged' else ''}.json").write_text(json.dumps(res, indent=2))
    print(sum(1 for r in res if "error" in r), "errors of", len(res))
