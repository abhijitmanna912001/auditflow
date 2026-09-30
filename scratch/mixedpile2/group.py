"""Grouping prototype v2. Input: an Intake output JSON list only (no filenames, no answer key).

1. Deterministic: union-find over reference tokens (doc_id + references). Components with 2+
   documents become groups. Numeric parts of IDs are never parsed.
2. One model call for documents left alone: the model may attach each to an EXISTING group or answer
   NONE. NONE, and anything the model omits, goes to `unplaced` for human placement. Unplaced
   documents never form a group of their own and are never merged with each other by the model
   (only a shared reference could link them, and that already happened in step 1).

usage: group.py INTAKE.json OUT.json
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
    for d in docs:
        find(d["doc_id"])
        for ref in d["references"]:
            parent[find(d["doc_id"])] = find(ref)
    comps = {}
    for d in docs:
        comps.setdefault(find(d["doc_id"]), []).append(d["doc_id"])
    return list(comps.values())


def summary(d):
    return (f'{d["doc_id"]} | {d["type"]} | vendor={d["vendor"]} | amount={d["amount"]} {d["currency"]} '
            f'| date={d["date"]} | refs={d["references"]}'
            + (f' | notes={d["extraction_notes"]}' if d.get("extraction_notes") else ""))


def model_assign(singles, groups, by_id, client):
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
        model=MODEL, max_tokens=16000,
        system=("You group financial documents into purchase transactions. For each unassigned "
                "document, choose the existing group it belongs to, using vendor, amount, currency, "
                "dates and references. If no group clearly fits, answer NONE. A wrong merge is worse "
                "than leaving a document for a human: do not force a match. Give a one-sentence reason."),
        messages=[{"role": "user", "content": "\n".join(lines)}],
        output_config={"format": {"type": "json_schema", "schema": schema}})
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)["assignments"]


def main():
    intake, out = sys.argv[1], sys.argv[2]
    docs = json.loads(Path(intake).read_text())
    by_id = {d["doc_id"]: d for d in docs}
    comps = deterministic(docs)
    groups = {f"G{i:02d}": sorted(c) for i, c in enumerate([c for c in comps if len(c) > 1], 1)}
    method = {m: "reference" for ms in groups.values() for m in ms}
    singles = sorted(c[0] for c in comps if len(c) == 1)

    log, unplaced = [], []
    if singles:
        log = model_assign(singles, groups, by_id, anthropic.Anthropic())
        answers = {a["doc_id"]: a for a in log}
        for s in singles:
            a = answers.get(s)
            if a and a["group"] in groups:
                groups[a["group"]].append(s)
                method[s] = "model"
            else:
                unplaced.append(s)
                method[s] = "unplaced"
        for g in groups:
            groups[g].sort()
    present = set(by_id)
    unresolved = {g: sorted({r for m in ms for r in by_id[m]["references"] if r not in present})
                  for g, ms in groups.items()}
    Path(out).write_text(json.dumps({"groups": groups, "unplaced": sorted(unplaced), "method": method,
                                     "model_calls": 1 if singles else 0, "model_assignments": log,
                                     "unresolved_refs": unresolved}, indent=1))
    print(f"{len(groups)} groups; {len(singles)} singletons -> model; {len(unplaced)} unplaced")


if __name__ == "__main__":
    main()
