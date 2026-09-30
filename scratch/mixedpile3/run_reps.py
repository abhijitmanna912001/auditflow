"""3 runs each of A_M, B and C through group.py; scores each with compare.py (fresh model calls every run)."""
import json, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from compare import score
allres = json.loads((ROOT / "scores.json").read_text()) if (ROOT / "scores.json").exists() else {}
for tag in sys.argv[1:] or ("A_M", "B", "C"):
    for r in (1, 2, 3):
        out = ROOT / f"groups_{tag}_r{r}.json"
        p = subprocess.run([sys.executable, str(ROOT / "group.py"), str(ROOT / f"intake_{tag}.json"), str(out)],
                           capture_output=True, text=True)
        print(tag, r, p.stdout.strip() or p.stderr[-400:], flush=True)
        if p.returncode != 0:
            if "401" in p.stderr: sys.exit(1)
            continue
        o, d = score(out, ROOT / f"intake_{tag}.json")
        allres[f"{tag}_r{r}"] = {"score": o, "detail": d}
        (ROOT / "scores.json").write_text(json.dumps(allres, indent=1))
