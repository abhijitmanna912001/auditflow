"""Step 2: existing Intake Agent on each batch folder; case_id overwritten with a neutral value.
Does not read the answer key."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent.parent / "agents"))
from intake_agent import run_intake_agent

out = []
for folder in sorted((ROOT / "batches").iterdir()):
    try:
        docs = run_intake_agent(str(folder))
    except Exception as e:
        print(folder.name, "ERROR", repr(e)[:300], flush=True)
        if "401" in repr(e):
            sys.exit(1)
        raise
    for d in docs:
        d["case_id"] = "PILE"
    out.extend(docs)
    print(folder.name, len(docs), "docs", flush=True)
(ROOT / "intake_output.json").write_text(json.dumps(out, indent=1))
print("total", len(out))
