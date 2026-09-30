"""The only script that reads the answer key. usage: compare.py GROUPS.json INTAKE.json -> prints + saves score."""
import json, sys, collections
from pathlib import Path
ROOT = Path(__file__).parent
K = json.loads((ROOT / "answer_key.json").read_text())["files"]
truth = {v["new_id"]: v["truth"] for v in K.values()}
res = json.loads(Path(sys.argv[1]).read_text())
intake = {d["doc_id"]: d for d in json.loads(Path(sys.argv[2]).read_text())}
assert set(intake) <= set(truth), set(intake) - set(truth)
groups, unplaced = res["groups"], set(res["unplaced"])
where = {d: g for g, ms in groups.items() for d in ms}
real = {d: t for d, t in truth.items() if d in intake and t.startswith("CASE_")}
dist = {d: t for d, t in truth.items() if d in intake and t.startswith("DIST_")}
mp = [d for d, t in truth.items() if d in intake and t.startswith("MULTI")]
out = {}

def real_truth(g):   # counts of real-case truths in a group
    return collections.Counter(truth[m] for m in groups[g])
true_cases = collections.defaultdict(list)
for d, c in real.items():
    true_cases[c].append(d)

group_major = {g: collections.Counter(truth[m] for m in ms if m in real).most_common(1)[0][0]
               for g, ms in groups.items() if any(m in real for m in ms)}
best_frag = {}
for c, ds in true_cases.items():
    fr = collections.Counter(where[d] for d in ds if d in where)
    best_frag[c] = fr.most_common(1)[0][0] if fr else None
correct = [d for d, c in real.items() if d in where and group_major.get(where[d]) == c and best_frag[c] == where[d]]
wrong_placed = [d for d, c in real.items() if d in where and d not in correct]
unpl_real = [d for d in real if d in unplaced]
splits = {c: sorted({where[d] for d in ds if d in where}) for c, ds in true_cases.items()
          if len({where[d] for d in ds if d in where}) > 1}
merges = {g: sorted({truth[m] for m in ms if not truth[m].startswith("MULTI")}) for g, ms in groups.items()
          if len({truth[m] for m in ms if not truth[m].startswith("MULTI")}) > 1}
print(f"real docs {len(real)}: correct {len(correct)}, placed wrong {len(wrong_placed)}, unplaced {len(unpl_real)}")
print(f"groups {len(groups)} (true real cases 14); split cases {len(splits)}: {splits}")
print(f"merged groups {len(merges)}: {merges}")
print("wrong-placed:", [(d, real[d], where[d]) for d in wrong_placed])
print("unplaced real:", [(d, real[d], intake[d]['type']) for d in unpl_real])

out.update(correct=len(correct), wrong=len(wrong_placed), unplaced=len(unpl_real), splits=splits, merges=merges,
           exact_cases=sum(1 for c, ds in true_cases.items()
                           if all(d in where and where[d] == best_frag[c] for d in ds)
                           and len(groups[best_frag[c]]) == len(ds)))
for d in dist:
    st = "unplaced" if d in unplaced else f"in {where[d]} (majority {group_major.get(where[d])})" if d in where else "?"
    print("distractor", d, dist[d], intake[d]["type"], "->", st)
    out.setdefault("distractors", {})[d] = st
for d in mp:
    st = "unplaced" if d in unplaced else f"in {where[d]} with truths {sorted(set(truth[m] for m in groups[where[d]]))}"
    print("multi-payment", d, "->", st)
    out["multi_payment"] = st

# false-missing exposure (would-be missing_po / missing_receipt on a real case's group)
print("\nfalse-missing exposure")
risk = []
for c in sorted(true_cases):
    tt = {intake[d]["type"] for d in true_cases[c]}
    g = best_frag[c]
    if g is None:
        print(c, "no group at all"); continue
    got = {intake[m]["type"] for m in groups[g]}
    lost = sorted((tt - got) & {"purchase_order", "receipt"})
    frags = [f for f in {where[d] for d in true_cases[c] if d in where} if f != g]
    fragless_inv = [f for f in frags if not any(intake[m]["type"] == "invoice" for m in groups[f])]
    unp = [d for d in true_cases[c] if d in unplaced]
    if lost or fragless_inv or unp:
        print(c, "group", g, "lacks", lost, "| unplaced:", [(d, intake[d]['type']) for d in unp],
              "| leftover fragments without invoice:", fragless_inv)
    if lost:
        risk.append({"case": c, "false_missing": lost})
out["false_missing_risk"] = risk
Path(ROOT / (Path(sys.argv[1]).stem + "_score.json")).write_text(json.dumps(out, indent=1))
