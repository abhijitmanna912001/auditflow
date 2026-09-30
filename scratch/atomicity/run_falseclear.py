"""Usage: run_falseclear.py CASE_92 20. Full pipeline N times, capturing every stage's raw output
(wraps the stage functions inside workpaper_agent; agent code untouched)."""
import json, sys, traceback
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent.parent / "agents"))
import workpaper_agent as wa

case, n = sys.argv[1], int(sys.argv[2])
cap = {}
def wrap(attr, key):
    orig = getattr(wa, attr)
    def f(*a, **k):
        r = orig(*a, **k); cap[key] = r; return r
    setattr(wa, attr, f)
for attr, key in [("run_intake_agent", "intake"), ("run_evidence_agent", "evidence"),
                  ("run_anomaly_agent", "anomaly"), ("run_decision_agent", "decision")]:
    wrap(attr, key)

out = ROOT / f"raw_falseclear_{case}.json"
runs = []
for i in range(1, n + 1):
    cap.clear()
    try:
        wp = wa.run_full_pipeline(str(ROOT / "cases" / case))
        runs.append({"run": i, **cap, "workpaper": wp})
    except Exception as e:
        runs.append({"run": i, "error": repr(e), **cap})
        traceback.print_exc()
        if "401" in repr(e):
            out.write_text(json.dumps(runs, indent=1)); sys.exit(1)
    out.write_text(json.dumps(runs, indent=1))
    print(case, i, flush=True)
