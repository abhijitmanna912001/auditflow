"""Step 3: group Intake output into transactions.

Input: an Intake output JSON list only. It never reads filenames or the answer key, and it does
not parse the numeric suffix of document IDs (that would exploit the benchmark's numbering).

1. Deterministic: union-find over reference tokens. Every document is joined to each token in its
   own doc_id + references list, so a doc that cites PO-X joins the PO-X document if present, and
   docs that cite the same token (a PO number with no PO document, or a supplier invoice number)
   still join each other.
2. Model: one call for documents left alone in a group, offered the existing groups' summaries.

usage: group.py INTAKE.json OUT.json [--strip-refs bank_statement,ledger_entry]
  --strip-refs is an ablation: blank out the references of those document types before grouping.
"""
import json, sys
from pathlib import Path
import anthropic

MODEL = "claude-sonnet-5"  # same model the agents use


def deterministic(docs):
    parent = {}
    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        parent[find(a)] = find(b)
    for d in docs:
        find(d["doc_id"])
        for ref in d["references"]:
            union(d["doc_id"], ref)
    comps = {}
    for d in docs:
        comps.setdefault(find(d["doc_id"]), []).append(d["doc_id"])
    return list(comps.values())


def summary(d):
    return (f'{d["doc_id"]} | {d["type"]} | vendor={d["vendor"]} | amount={d["amount"]} {d["currency"]} '
            f'| date={d["date"]} | refs={d["references"]}')


def model_assign(singles, groups, by_id, client):
    """One model call: place each lone document in an existing group or mark it NEW."""
    lines = ["Existing groups (documents believed to belong to one purchase transaction):"]
    for gid, members in groups.items():
        lines.append(f"[{gid}]")
        lines += ["  " + summary(by_id[m]) for m in members]
    lines.append("\nUnassigned documents:")
    lines += [summary(by_id[s]) for s in singles]
    schema = {"type": "object", "properties": {"assignments": {"type": "array", "items": {
        "type": "object", "properties": {"doc_id": {"type": "string"}, "group": {"type": "string"},
                                          "reason": {"type": "string"}},
        "required": ["doc_id", "group", "reason"], "additionalProperties": False}}},
        "required": ["assignments"], "additionalProperties": False}
    resp = client.messages.create(
        model=MODEL, max_tokens=8000,
        system=("You group financial documents into purchase transactions. For each unassigned "
                "document, choose the existing group it belongs to, using vendor, amount, currency, "
                "dates and references. If none fits, answer NEW. Do not force a match: a wrong merge "
                "is worse than leaving a document alone. Give a one-sentence reason."),
        messages=[{"role": "user", "content": "\n".join(lines)}],
        output_config={"format": {"type": "json_schema", "schema": schema}})
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)["assignments"]


def main():
    intake, out = sys.argv[1], sys.argv[2]
    strip = set()
    if "--strip-refs" in sys.argv:
        strip = set(sys.argv[sys.argv.index("--strip-refs") + 1].split(","))
    docs = json.loads(Path(intake).read_text())
    for d in docs:
        if d["type"] in strip:
            d["references"] = []
    by_id = {d["doc_id"]: d for d in docs}

    comps = deterministic(docs)
    multi = [c for c in comps if len(c) > 1]
    singles = [c[0] for c in comps if len(c) == 1]
    groups = {f"G{i:02d}": sorted(c) for i, c in enumerate(multi, 1)}
    method = {m: "reference" for c in multi for m in c}

    model_log = []
    if singles:
        assignments = model_assign(singles, groups, by_id, anthropic.Anthropic())
        model_log = assignments
        n = len(groups)
        for a in assignments:
            if a["group"] in groups:
                groups[a["group"]].append(a["doc_id"])
            else:
                n += 1
                groups[f"G{n:02d}"] = [a["doc_id"]]
            method[a["doc_id"]] = "model"
        for s in singles:                       # anything the model omitted stays alone
            if s not in method:
                n += 1
                groups[f"G{n:02d}"] = [s]
                method[s] = "unassigned"
    for g in groups:
        groups[g].sort()

    # references that point at no document in the pile (what a missing-document check would see)
    present = set(by_id)
    unresolved = {g: sorted({r for m in ms for r in by_id[m]["references"] if r not in present})
                  for g, ms in groups.items()}
    Path(out).write_text(json.dumps({"groups": groups, "method": method, "model_calls": 1 if singles else 0,
                                     "model_assignments": model_log, "unresolved_refs": unresolved,
                                     "strip_refs": sorted(strip)}, indent=1))
    print(f"{len(groups)} groups; {len(singles)} singletons sent to model; strip={sorted(strip)}")


if __name__ == "__main__":
    main()
