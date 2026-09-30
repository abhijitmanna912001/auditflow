"""Grouping prototype v3. Input: an Intake output JSON list only (no filenames, no answer key).

1. ANCHORS: invoices, purchase orders and receipts (a GRN is a receipt) build groups. Union-find over
   their own doc_id + references. A component containing an invoice or PO becomes a group; a receipt
   with no anchor of its own is left for step 2. Bank statements and ledger entries NEVER join groups.
2. ATTACH: each bank statement / ledger entry / lone receipt is attached to every group whose
   documents or dangling reference tokens it cites. A document matching several groups is
   linked to each of them and recorded as `shared`; it never merges groups. Documents with no
   reference match go to one model call, which may link them to zero, one or several groups from
   vendor, amount, currency and date.
3. CLUSTER: documents still unplaced go to one model call that may cluster them among themselves.
   Code-enforced: 2+ documents, identical vendor string (normalised), confidence >= 0.7, and stated
   reasons. Anything else stays unplaced. Clusters are NOT groups: they stay flagged for a human.
4. Every unplaced document is listed with a reason in `unplaced_report`.

usage: group.py INTAKE.json OUT.json
"""
import json, sys
from pathlib import Path
import anthropic

MODEL = "claude-sonnet-5"      # same model the agents use
ANCHOR_TYPES = {"invoice", "purchase_order", "receipt"}
SEED_TYPES = {"invoice", "purchase_order"}
MIN_CLUSTER_CONFIDENCE = 0.7


def anchor_groups(docs):
    anchors = [d for d in docs if d["type"] in ANCHOR_TYPES]
    parent = {}
    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for d in anchors:
        find(d["doc_id"])
        for r in d["references"]:
            parent[find(d["doc_id"])] = find(r)
    comps = {}
    for d in anchors:
        comps.setdefault(find(d["doc_id"]), []).append(d)
    groups = []
    for members in comps.values():
        if any(m["type"] in SEED_TYPES for m in members):
            groups.append(sorted(m["doc_id"] for m in members))
    return groups


def summary(d):
    s = (f'{d["doc_id"]} | {d["type"]} | vendor={d["vendor"]} | amount={d["amount"]} {d["currency"]} '
         f'| date={d["date"]} | refs={d["references"]}')
    return s + (f' | notes={d["extraction_notes"]}' if d.get("extraction_notes") else "")


def call_json(client, system, user, schema, max_tokens=16000):
    resp = client.messages.create(
        model=MODEL, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"format": {"type": "json_schema", "schema": schema}})
    return json.loads(next(b.text for b in resp.content if b.type == "text"))


ATTACH_SCHEMA = {"type": "object", "properties": {"assignments": {"type": "array", "items": {
    "type": "object", "properties": {
        "doc_id": {"type": "string"},
        "groups": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number"},
        "reason": {"type": "string"}},
    "required": ["doc_id", "groups", "confidence", "reason"], "additionalProperties": False}}},
    "required": ["assignments"], "additionalProperties": False}

CLUSTER_SCHEMA = {"type": "object", "properties": {"clusters": {"type": "array", "items": {
    "type": "object", "properties": {
        "doc_ids": {"type": "array", "items": {"type": "string"}},
        "vendor": {"type": "string"},
        "confidence": {"type": "number"},
        "reasons": {"type": "string"}},
    "required": ["doc_ids", "vendor", "confidence", "reasons"], "additionalProperties": False}}},
    "required": ["clusters"], "additionalProperties": False}


def norm(v):
    return " ".join((v or "").lower().replace(".", "").replace(",", "").split())


def main():
    intake_path, out_path = sys.argv[1], sys.argv[2]
    docs = json.loads(Path(intake_path).read_text())
    by_id = {d["doc_id"]: d for d in docs}
    client = anthropic.Anthropic()

    groups = {f"G{i:02d}": {"members": ids, "shared": []} for i, ids in enumerate(anchor_groups(docs), 1)}
    tokens = {g: {m for i in v["members"] for m in [i] + by_id[i]["references"]} for g, v in groups.items()}
    anchored = {m for v in groups.values() for m in v["members"]}
    pending = [d for d in docs if d["doc_id"] not in anchored]

    links = {}             # doc_id -> list of group ids
    method, reasons = {}, {}
    to_model = []
    for d in pending:
        hit = sorted(g for g, t in tokens.items() if set(d["references"]) & t)
        if hit:
            links[d["doc_id"]], method[d["doc_id"]] = hit, "reference"
        else:
            to_model.append(d)

    attach_log = []
    if to_model:
        lines = ["Groups (each is one purchase transaction, anchored by its invoice/PO/receipt):"]
        for g, v in groups.items():
            lines.append(f"[{g}]")
            lines += ["  " + summary(by_id[m]) for m in v["members"]]
        lines.append("\nDocuments to attach:")
        lines += [summary(d) for d in to_model]
        data = call_json(
            client,
            ("You attach bank statements, ledger entries and receipts to purchase-transaction groups. "
             "For each document return the group ids it belongs to, judging by vendor, amount, currency "
             "and dates. Return one group for a normal single-payment document. Return several groups "
             "ONLY when the document itself covers several transactions (for example a statement "
             "listing payments for different invoices); such a document is shared and does not merge "
             "the groups. Return an empty list when no group clearly fits: do not force a match, a "
             "wrong attachment is worse than leaving it for a human. Give a confidence 0-1 and a "
             "one-sentence reason."),
            "\n".join(lines), ATTACH_SCHEMA)
        attach_log = data["assignments"]
        answers = {a["doc_id"]: a for a in attach_log}
        for d in to_model:
            a = answers.get(d["doc_id"])
            gs = [g for g in (a["groups"] if a else []) if g in groups]
            if gs:
                links[d["doc_id"]], method[d["doc_id"]] = sorted(set(gs)), "model"
            reasons[d["doc_id"]] = a["reason"] if a else "model returned no answer"

    for doc_id, gs in links.items():
        for g in gs:
            groups[g]["members"].append(doc_id)
            if len(gs) > 1:
                groups[g]["shared"].append(doc_id)
    shared = {d: gs for d, gs in links.items() if len(gs) > 1}
    for v in groups.values():
        v["members"].sort()
        v["shared"].sort()

    unplaced = sorted(d["doc_id"] for d in pending if d["doc_id"] not in links)

    cluster_log, clusters, rejected = [], [], []
    if len(unplaced) >= 2:
        lines = ["Unplaced documents:"] + [summary(by_id[u]) for u in unplaced]
        data = call_json(
            client,
            ("You cluster unplaced financial documents that belong to the same purchase transaction. "
             "Only propose a cluster when the vendor is the same AND the amounts or dates agree. Never "
             "cluster documents from different vendors. A wrong cluster is worse than leaving documents "
             "unclustered. For each cluster give the vendor, a confidence 0-1 and the reasons. Leave "
             "doubtful documents out."),
            "\n".join(lines), CLUSTER_SCHEMA)
        cluster_log = data["clusters"]
        used = set()
        for c in cluster_log:
            ids = c["doc_ids"]
            vendors = {norm(by_id[i]["vendor"]) for i in ids if i in by_id}
            problem = None
            if len(set(ids)) < 2: problem = "fewer than 2 documents"
            elif any(i not in unplaced for i in ids): problem = "contains a document that is not unplaced"
            elif set(ids) & used: problem = "overlaps another cluster"
            elif len(vendors) != 1 or "" in vendors: problem = f"vendors differ: {sorted(vendors)}"
            elif c["confidence"] < MIN_CLUSTER_CONFIDENCE: problem = f"confidence {c['confidence']} below {MIN_CLUSTER_CONFIDENCE}"
            elif not c["reasons"].strip(): problem = "no reasons"
            if problem:
                rejected.append({**c, "rejected_because": problem})
            else:
                used |= set(ids)
                clusters.append({"cluster_id": f"U{len(clusters) + 1:02d}", "doc_ids": sorted(ids),
                                 "vendor": c["vendor"], "confidence": c["confidence"], "reasons": c["reasons"]})
    in_cluster = {i: c["cluster_id"] for c in clusters for i in c["doc_ids"]}

    report = []
    for u in unplaced:
        d = by_id[u]
        why = reasons.get(u) or "no reference to any group and not matched by vendor/amount/date"
        report.append({"doc_id": u, "type": d["type"], "vendor": d["vendor"], "amount": d["amount"],
                       "date": d["date"], "reason": why,
                       "cluster": in_cluster.get(u), "status": "clustered, needs human placement" if u in in_cluster
                       else "unplaced, needs human placement"})

    unresolved = {g: sorted({r for m in v["members"] for r in by_id[m]["references"] if r not in by_id})
                  for g, v in groups.items()}
    Path(out_path).write_text(json.dumps({
        "groups": groups, "shared": shared, "clusters": clusters, "rejected_clusters": rejected,
        "unplaced_report": report, "method": method, "unresolved_refs": unresolved,
        "attach_log": attach_log, "cluster_log": cluster_log,
        "model_calls": int(bool(to_model)) + int(len(unplaced) >= 2)}, indent=1))
    print(f"{len(groups)} groups; {len(shared)} shared; {len(to_model)} to model; "
          f"{len(unplaced)} unplaced ({len(in_cluster)} clustered in {len(clusters)}); "
          f"{len(rejected)} clusters rejected")


if __name__ == "__main__":
    main()
