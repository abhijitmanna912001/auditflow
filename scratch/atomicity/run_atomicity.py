"""Run run_full_pipeline 5x per scratch case; dump raw workpaper + slim summary to JSON."""
import json, sys, time, traceback
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent.parent / "agents"))
from workpaper_agent import run_full_pipeline

N = 5
out_path = ROOT / "raw_runs.json"
results = json.loads(out_path.read_text()) if out_path.exists() else {}
for case in sorted(p.name for p in (ROOT / "cases").iterdir()):
    results.setdefault(case, [])
    while len(results[case]) < N:
        i = len(results[case]) + 1
        t = time.time()
        try:
            wp = run_full_pipeline(str(ROOT / "cases" / case))
            results[case].append({"run": i, "workpaper": wp})
        except Exception as e:
            results[case].append({"run": i, "error": repr(e)})
            traceback.print_exc()
        out_path.write_text(json.dumps(results, indent=1))
        print(case, i, f"{time.time()-t:.0f}s", flush=True)
