"""Build variants A/B/C (with and without the multi-payment statement), run group.py on each.
A: references as extracted. B: references blanked on bank statements, ledger entries, receipts.
C: B + the 3 distractors (invoices keep their references)."""
import json, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).parent
core = json.loads((ROOT / "intake_core.json").read_text())
dist = json.loads((ROOT / "intake_dist.json").read_text())
mp = json.loads((ROOT / "intake_mp.json").read_text())
BLANK = {"bank_statement", "ledger_entry", "receipt"}
def blank(docs):
    out = json.loads(json.dumps(docs))
    for d in out:
        if d["type"] in BLANK:
            d["references"] = []
    return out
variants = {"A": core, "B": blank(core), "C": blank(core) + dist}
for name, docs in variants.items():
    for suffix, extra in (("", []), ("_M", blank(mp) if name != "A" else mp)):
        tag = f"{name}{suffix}"
        (ROOT / f"intake_{tag}.json").write_text(json.dumps(docs + extra, indent=1))
        print("==", tag, flush=True)
        subprocess.run([sys.executable, str(ROOT / "group.py"), str(ROOT / f"intake_{tag}.json"),
                        str(ROOT / f"groups_{tag}.json")], check=True)
