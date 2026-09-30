"""Existing Intake Agent per batch folder (folder names are neutral); case_id overwritten with PILE.
Saves intake_core.json (67 docs), intake_dist.json (3), intake_mp.json (1). Never reads the key."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent.parent / "agents"))
from intake_agent import run_intake_agent

parts = {"core": [], "dist": [], "mp": []}
for folder in sorted((ROOT / "batches").iterdir()):
    part = "dist" if folder.name == "BATCH_DIST" else "mp" if folder.name == "BATCH_MP" else "core"
    try:
        docs = run_intake_agent(str(folder))
    except Exception as e:
        print(folder.name, "ERROR", repr(e)[:300], flush=True)
        sys.exit(1)
    for d in docs:
        d["case_id"] = "PILE"
    parts[part].extend(docs)
    print(folder.name, len(docs), "docs", flush=True)
for k, v in parts.items():
    (ROOT / f"intake_{k}.json").write_text(json.dumps(v, indent=1))
