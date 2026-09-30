"""Step 4: the only script that reads the answer key. usage: compare.py GROUPS.json"""
import json, sys, collections
from pathlib import Path
ROOT = Path(__file__).parent
key = json.loads((ROOT / "answer_key.json").read_text())
intake = {d["doc_id"]: d for d in json.loads((ROOT / "intake_output.json").read_text())}
truth = {Path(v["original"]).stem: v["case"] for v in key.values()}      # doc_id -> case
assert set(truth) == set(intake), (set(truth) ^ set(intake))
res = json.loads(Path(sys.argv[1]).read_text())
groups = res["groups"]

true_cases = collections.defaultdict(list)
for d, c in truth.items():
    true_cases[c].append(d)
where = {d: g for g, ms in groups.items() for d in ms}

wrong = []
group_major = {}
for g, ms in groups.items():
    group_major[g] = collections.Counter(truth[m] for m in ms).most_common(1)[0][0]
# a doc is correctly placed if its group's majority case is its case AND its case's largest predicted
# fragment is that group (avoids crediting both halves of a split)
best_frag = {}
for c, ds in true_cases.items():
    frag = collections.Counter(where[d] for d in ds)
    best_frag[c] = frag.most_common(1)[0][0]
correct_docs = 0
for d, c in truth.items():
    g = where[d]
    if group_major[g] == c and best_frag[c] == g:
        correct_docs += 1
    else:
        wrong.append(d)

splits = {c: sorted(set(where[d] for d in ds)) for c, ds in true_cases.items() if len({where[d] for d in ds}) > 1}
merges = {g: sorted({truth[m] for m in ms}) for g, ms in groups.items() if len({truth[m] for m in ms}) > 1}
exact = [c for c, ds in true_cases.items() if len({where[d] for d in ds}) == 1
         and len(groups[where[ds[0]]]) == len(ds)]

print(f"docs total {len(truth)}; correctly placed {correct_docs}; wrong {len(wrong)}")
print(f"true cases {len(true_cases)}; predicted groups {len(groups)}; exact-match cases {len(exact)}")
print("split cases:", splits)
print("merged groups:", merges)
print("method counts:", dict(collections.Counter(res["method"].values())))
print("wrong docs:", [(d, truth[d], where[d]) for d in wrong])

# false-missing exposure: what a per-group missing check would see vs the true case
print("\nper-case: predicted group composition vs truth")
tw = {"PO": "purchase_order", "REC": "receipt", "BNK": "bank_statement", "INV": "invoice", "LED": "ledger_entry"}
for c in sorted(true_cases):
    ds = true_cases[c]
    frag = collections.Counter(where[d] for d in ds)
    g = best_frag[c]
    got = {intake[m]["type"] for m in groups[g]}
    truth_types = {intake[d]["type"] for d in ds}
    lost = sorted(truth_types - got)
    extra = sorted(m for m in groups[g] if truth[m] != c)
    print(c, "frags", dict(frag), "types lacking in best group vs truth:", lost,
          "| foreign docs in group:", extra, "| unresolved refs:", res["unresolved_refs"][g])
json.dump({"correct": correct_docs, "wrong": wrong, "splits": splits, "merges": merges, "exact": exact},
          open(ROOT / (Path(sys.argv[1]).stem + "_score.json"), "w"), indent=1)
