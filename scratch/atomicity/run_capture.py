"""Same as run_atomicity.py but captures the Anomaly and Decision outputs that
run_full_pipeline consumes (wraps the module-level functions; agent code untouched)."""
import json, sys, time, traceback
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent.parent / "agents"))
import workpaper_agent as wa

cap = {}
_a, _d = wa.run_anomaly_agent, wa.run_decision_agent
wa.run_anomaly_agent = lambda *a, **k: cap.__setitem__("anomaly", r := _a(*a, **k)) or r
wa.run_decision_agent = lambda *a, **k: cap.__setitem__("decision", r := _d(*a, **k)) or r

N = 5
out = ROOT / "raw_runs.json"
results = json.loads(out.read_text()) if out.exists() else {}
for case in sorted(p.name for p in (ROOT / "cases").iterdir()):
    results.setdefault(case, [])
    while len(results[case]) < N:
        i = len(results[case]) + 1
        cap.clear()
        try:
            wp = wa.run_full_pipeline(str(ROOT / "cases" / case))
            results[case].append({"run": i, "anomaly": cap.get("anomaly"), "decision": cap.get("decision"), "workpaper": wp})
        except Exception as e:
            results[case].append({"run": i, "error": repr(e)})
            traceback.print_exc()
            if "401" in repr(e):
                out.write_text(json.dumps(results, indent=1)); sys.exit(1)
        out.write_text(json.dumps(results, indent=1))
        print(case, i, flush=True)
