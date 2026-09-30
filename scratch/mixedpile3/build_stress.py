"""BUILD step (reads the answer key to choose what to remove; group.py never does).
Variant D = C minus the invoice and PO of CASE_01, 02, 06 and 13, i.e. their receipt/bank/ledger
documents (references blanked) have no anchor to attach to. D also keeps the 3 distractors
(two Horizon invoices and a CloudDesk PO, lookalikes of CASE_01 and CASE_02). This exercises the
clustering step, which variants A/B/C never reached. CASE_06 (Meridian Network Components) and
CASE_13 (Meridian Cloud Services) are near-name vendors, to test 'never merge different vendors'."""
import json
from pathlib import Path
ROOT = Path(__file__).parent
K = json.loads((ROOT / "answer_key.json").read_text())["files"]
truth = {v["new_id"]: v["truth"] for v in K.values()}
drop_cases = {"CASE_01", "CASE_02", "CASE_06", "CASE_13"}
docs = json.loads((ROOT / "intake_C.json").read_text())
kept = [d for d in docs if not (truth[d["doc_id"]] in drop_cases and d["type"] in ("invoice", "purchase_order"))]
(ROOT / "intake_D.json").write_text(json.dumps(kept, indent=1))
print(len(docs), "->", len(kept), "docs")
