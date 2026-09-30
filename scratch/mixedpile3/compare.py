"""The only script that reads the answer key. usage: compare.py GROUPS.json INTAKE.json [--quiet]
Prints/returns per-run metrics."""
import json, sys, collections
from pathlib import Path
ROOT = Path(__file__).parent


def score(groups_path, intake_path, verbose=True):
    K = json.loads((ROOT / "answer_key.json").read_text())["files"]
    truth = {v["new_id"]: v["truth"] for v in K.values()}
    res = json.loads(Path(groups_path).read_text())
    intake = {d["doc_id"]: d for d in json.loads(Path(intake_path).read_text())}
    groups = res["groups"]
    shared = set(res["shared"])
    unplaced = {u["doc_id"] for u in res["unplaced_report"]}
    cluster_of = {i: c["cluster_id"] for c in res["clusters"] for i in c["doc_ids"]}
    reasons = {a["doc_id"]: a["reason"] for a in res["attach_log"]}
    real = {d: t for d, t in truth.items() if d in intake and t.startswith("CASE_")}
    dist = {d: t for d, t in truth.items() if d in intake and t.startswith("DIST_")}
    mp = [d for d, t in truth.items() if d in intake and t.startswith("MULTI")]
    where = {}                                   # non-shared doc -> group
    for g, v in groups.items():
        for m in v["members"]:
            if m not in shared:
                where[m] = g
    def gtruths(g):                              # truths of non-shared members
        return collections.Counter(truth[m] for m in groups[g]["members"] if m not in shared)
    major = {g: gtruths(g).most_common(1)[0][0] for g in groups if gtruths(g)}
    true_cases = collections.defaultdict(list)
    for d, t in real.items():
        true_cases[t].append(d)
    best = {}
    for c, ds in true_cases.items():
        fr = collections.Counter(where[d] for d in ds if d in where)
        best[c] = fr.most_common(1)[0][0] if fr else None
    correct = [d for d, c in real.items() if d in where and major.get(where[d]) == c and best[c] == where[d]]
    wrong = [d for d, c in real.items() if d in where and d not in correct]
    unpl = [d for d in real if d in unplaced]
    shared_real = [d for d in real if d in shared]
    splits = {c: sorted({where[d] for d in ds if d in where}) for c, ds in true_cases.items()
              if len({where[d] for d in ds if d in where}) > 1}
    merges = {g: dict(gtruths(g)) for g in groups if len(gtruths(g)) > 1}
    cl_merges = {}
    for c in res["clusters"]:
        t = collections.Counter(truth[i] for i in c["doc_ids"])
        if len(t) > 1:
            cl_merges[c["cluster_id"]] = dict(t)
    out = {"correct": len(correct), "wrong": len(wrong), "unplaced": len(unpl), "shared_real": len(shared_real),
           "splits": len(splits), "merges": len(merges), "cluster_merges": len(cl_merges),
           "groups": len(groups), "clusters": len(res["clusters"]), "rejected_clusters": len(res["rejected_clusters"]),
           "model_calls": res["model_calls"]}
    detail = {"splits": splits, "merges": merges, "cluster_merges": cl_merges}
    # requested specific answers
    def cluster_or_group(d):
        return where.get(d) or cluster_of.get(d) or ("shared" if d in shared else "unplaced")
    for c in ("CASE_05", "CASE_11"):
        ds = true_cases[c]
        homes = {cluster_or_group(d) for d in ds}
        foreign = []
        for h in homes:
            if h in groups:
                foreign += [m for m in groups[h]["members"] if truth[m] != c and m not in shared]
            else:
                for cl in res["clusters"]:
                    if cl["cluster_id"] == h:
                        foreign += [m for m in cl["doc_ids"] if truth[m] != c]
        out[f"{c}_one_home"] = len(homes) == 1 and not foreign and next(iter(homes)) in groups
        detail[f"{c}_homes"] = sorted(homes)
        detail[f"{c}_foreign"] = foreign
    if mp:
        links = res["shared"].get(mp[0]) or [where.get(mp[0])] if (mp[0] in shared or mp[0] in where) else []
        linked_cases = sorted({major.get(g) for g in links if g})
        out["mp_linked_cases"] = linked_cases
        out["mp_shared"] = mp[0] in shared
        out["mp_merged_groups"] = bool(merges)
    out["distractors"] = {d: ("unplaced" if d in unplaced else f"in {where.get(d)}") for d in dist}
    out["distractor_docs_in_real_groups"] = [d for d in dist if where.get(d) and major.get(where[d]) not in (None, dist[d])]
    # real docs attached into a distractor group
    out["real_docs_in_distractor_groups"] = [d for d in real if d in where and major.get(where[d], "").startswith("DIST_")]
    # false-missing exposure: PO/receipt of a real case absent from its best group
    risk = []
    for c, ds in true_cases.items():
        g = best[c]
        if not g:
            risk.append({"case": c, "why": "no group"}); continue
        types_truth = {intake[d]["type"] for d in ds}
        types_got = {intake[m]["type"] for m in groups[g]["members"]}
        lost = sorted((types_truth - types_got) & {"purchase_order", "receipt"})
        if lost:
            risk.append({"case": c, "false_missing": lost})
    out["false_missing_risk"] = risk
    detail["wrong_docs"] = [(d, real[d], where[d], major[where[d]], reasons.get(d)) for d in wrong]
    detail["cluster_merge_reasons"] = {c["cluster_id"]: c["reasons"] for c in res["clusters"] if c["cluster_id"] in cl_merges}
    detail["group_merge_reasons"] = {g: {m: reasons.get(m, "reference-linked") for m in groups[g]["members"]
                                        if m not in shared and truth[m] != major[g]} for g in merges}
    return out, detail


if __name__ == "__main__":
    o, d = score(sys.argv[1], sys.argv[2])
    print(json.dumps(o, indent=1)); print(json.dumps(d, indent=1))
