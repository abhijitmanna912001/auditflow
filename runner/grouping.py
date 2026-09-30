"""Group Intake documents into transactions. Input is Intake output only (no file names, no answer
key); numeric parts of IDs are never parsed.

1. ANCHORS: invoices, POs and receipts build groups by union-find over their doc_id + references. A
   component containing an invoice or PO is a group. Bank statements and ledger entries never join
   groups.
2. ATTACH: bank statements, ledger entries and reference-less receipts attach to every group they
   cite (a document linked to several groups is `shared`, and never merges them); the rest go to one
   model call (vendor, amount, date). AMOUNT RULE, enforced in code for every attachment: a document
   attaches to a group only if its amount equals the amount of an anchor in that group, or it states
   no amount and a reference links it. Otherwise it is unplaced.
3. CLUSTER: unplaced documents may be clustered among themselves by one model call (same vendor
   enforced in code, confidence >= 0.7, reasons required). Clusters are hints for a human, not groups.
Every document that is not in a group appears in `unplaced` with a reason.
"""
from __future__ import annotations

import json
import logging
from typing import Callable

log = logging.getLogger("runner.grouping")

MODEL = "claude-sonnet-5"      # same model the agents use
ANCHOR_TYPES = {"invoice", "purchase_order", "receipt"}
SEED_TYPES = {"invoice", "purchase_order"}
AMOUNT_TOLERANCE = 0.01
MIN_CLUSTER_CONFIDENCE = 0.7

_ATTACH_SCHEMA = {"type": "object", "properties": {"assignments": {"type": "array", "items": {
    "type": "object", "properties": {"doc_id": {"type": "string"}, "groups": {"type": "array", "items": {"type": "string"}},
                                      "confidence": {"type": "number"}, "reason": {"type": "string"}},
    "required": ["doc_id", "groups", "confidence", "reason"], "additionalProperties": False}}},
    "required": ["assignments"], "additionalProperties": False}
_CLUSTER_SCHEMA = {"type": "object", "properties": {"clusters": {"type": "array", "items": {
    "type": "object", "properties": {"doc_ids": {"type": "array", "items": {"type": "string"}}, "vendor": {"type": "string"},
                                      "confidence": {"type": "number"}, "reasons": {"type": "string"}},
    "required": ["doc_ids", "vendor", "confidence", "reasons"], "additionalProperties": False}}},
    "required": ["clusters"], "additionalProperties": False}


def _summary(d: dict) -> str:
    return (f'{d["doc_id"]} | {d["type"]} | vendor={d["vendor"]} | amount={d["amount"]} {d["currency"]} '
            f'| date={d["date"]} | refs={d["references"]}')


def _norm(v):
    return " ".join((v or "").lower().replace(".", "").replace(",", "").split())


def _anchor_components(docs: list[dict]) -> list[list[str]]:
    parent: dict[str, str] = {}
    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    anchors = [d for d in docs if d["type"] in ANCHOR_TYPES]
    for d in anchors:
        find(d["doc_id"])
        for r in d["references"]:
            parent[find(d["doc_id"])] = find(r)
    comps: dict[str, list[dict]] = {}
    for d in anchors:
        comps.setdefault(find(d["doc_id"]), []).append(d)
    return [sorted(m["doc_id"] for m in ms) for ms in comps.values() if any(m["type"] in SEED_TYPES for m in ms)]


def amount_rule(doc: dict, anchor_amounts: list[float], reference_linked: bool) -> tuple[bool, str]:
    """(ok, reason). See module docstring, AMOUNT RULE."""
    amt = doc["amount"]
    if amt is None:
        return (True, "no amount stated; linked by reference") if reference_linked else \
               (False, "states no amount and no reference links it to a group")
    if any(abs(amt - a) <= AMOUNT_TOLERANCE for a in anchor_amounts):
        return True, "amount matches an anchor amount"
    shown = ", ".join(f"{a:,.2f}" for a in sorted(set(anchor_amounts))) or "none"
    return False, f"amount {amt:,.2f} matches no anchor amount in the group ({shown})"


def _call_json(client, system: str, user: str, schema: dict) -> dict:
    resp = client.messages.create(model=MODEL, max_tokens=16000, system=system,
                                  messages=[{"role": "user", "content": user}],
                                  output_config={"format": {"type": "json_schema", "schema": schema}})
    return json.loads(next(b.text for b in resp.content if b.type == "text"))


def group_documents(docs: list[dict], client=None, model_call: Callable | None = None) -> dict:
    """docs: Intake output dicts (unique doc_id). `model_call(kind, system, user, schema)` can replace the
    real API call (tests). Returns {groups, shared, clusters, unplaced, model_calls}."""
    if client is None and model_call is None:
        import anthropic
        client = anthropic.Anthropic()
    call = model_call or (lambda kind, system, user, schema: _call_json(client, system, user, schema))
    by_id = {d["doc_id"]: d for d in docs}
    groups = {f"G{i:02d}": {"members": ids, "anchors": list(ids), "shared": []}
              for i, ids in enumerate(_anchor_components(docs), 1)}
    tokens = {g: {t for i in v["anchors"] for t in [i] + by_id[i]["references"]} for g, v in groups.items()}
    anchor_amounts = {g: [by_id[i]["amount"] for i in v["anchors"] if by_id[i]["amount"] is not None]
                      for g, v in groups.items()}
    anchored = {i for v in groups.values() for i in v["anchors"]}
    pending = [d for d in docs if d["doc_id"] not in anchored]

    links: dict[str, list[str]] = {}
    unplaced: dict[str, str] = {}
    to_model = []
    for d in pending:
        hit = sorted(g for g, t in tokens.items() if set(d["references"]) & t)
        if not hit:
            to_model.append(d)
            continue
        ok, why = [], []
        for g in hit:
            good, reason = amount_rule(d, anchor_amounts[g], reference_linked=True)
            (ok if good else why).append(g if good else f"{g}: {reason}")
        if ok:
            links[d["doc_id"]] = ok
        else:
            unplaced[d["doc_id"]] = "cites a group but amount check failed (" + "; ".join(why) + ")"

    calls = 0
    if to_model:
        lines = ["Groups (each is one purchase transaction, anchored by its invoice/PO/receipt):"]
        for g, v in groups.items():
            lines.append(f"[{g}]")
            lines += ["  " + _summary(by_id[m]) for m in v["anchors"]]
        lines += ["", "Documents to attach:"] + [_summary(d) for d in to_model]
        data = call("attach",
                    "You attach bank statements, ledger entries and receipts to purchase-transaction groups. For "
                    "each document return the group ids it belongs to, judging by vendor, amount, currency and "
                    "dates. Return one group for a normal single-payment document; several only when the "
                    "document itself covers several transactions. Return an empty list when no group clearly "
                    "fits: a wrong attachment is worse than leaving it for a human. Give a confidence 0-1 and a "
                    "one-sentence reason.", "\n".join(lines), _ATTACH_SCHEMA)
        calls += 1
        answers = {a["doc_id"]: a for a in data["assignments"]}
        for d in to_model:
            a = answers.get(d["doc_id"])
            gs = sorted({g for g in (a["groups"] if a else []) if g in groups})
            if not gs:
                unplaced[d["doc_id"]] = "no group clearly matches (" + (a["reason"] if a else "no model answer") + ")"
                continue
            ok, why = [], []
            for g in gs:
                good, reason = amount_rule(d, anchor_amounts[g], reference_linked=False)
                (ok if good else why).append(g if good else f"{g}: {reason}")
            if ok:
                links[d["doc_id"]] = ok
            else:
                unplaced[d["doc_id"]] = "model matched a group but amount check failed (" + "; ".join(why) + ")"

    shared = {d: gs for d, gs in links.items() if len(gs) > 1}
    for d, gs in links.items():
        for g in gs:
            groups[g]["members"].append(d)
            if len(gs) > 1:
                groups[g]["shared"].append(d)
    for v in groups.values():
        v["members"].sort()

    # documents whose group has no invoice cannot be checked (nothing to compare): report, don't drop
    for g, v in list(groups.items()):
        if not any(by_id[i]["type"] == "invoice" for i in v["anchors"]):
            for m in v["members"]:
                if m not in shared:
                    unplaced[m] = "group has no invoice (e.g. a PO that no invoice cites); nothing to check it against"
            groups.pop(g)

    clusters = []
    ids = sorted(unplaced)
    if len(ids) >= 2:
        data = call("cluster",
                    "You cluster unplaced financial documents that belong to the same purchase transaction. Only "
                    "propose a cluster when the vendor is the same AND the amounts or dates agree. Never cluster "
                    "documents from different vendors. A wrong cluster is worse than none. Give the vendor, a "
                    "confidence 0-1 and the reasons. Leave doubtful documents out.",
                    "Unplaced documents:\n" + "\n".join(_summary(by_id[i]) for i in ids), _CLUSTER_SCHEMA)
        calls += 1
        used: set[str] = set()
        for c in data["clusters"]:
            cid = c["doc_ids"]
            vendors = {_norm(by_id[i]["vendor"]) for i in cid if i in by_id}
            if (len(set(cid)) >= 2 and all(i in unplaced for i in cid) and not (set(cid) & used)
                    and len(vendors) == 1 and "" not in vendors and c["confidence"] >= MIN_CLUSTER_CONFIDENCE
                    and c["reasons"].strip()):
                used |= set(cid)
                clusters.append({"cluster_id": f"U{len(clusters) + 1:02d}", "doc_ids": sorted(cid),
                                 "confidence": c["confidence"], "reasons": c["reasons"]})
    in_cluster = {i: c["cluster_id"] for c in clusters for i in c["doc_ids"]}
    report = [{"doc_id": i, "reason": unplaced[i], "cluster": in_cluster.get(i)} for i in ids]
    log.info("grouping: %d docs, %d groups, %d shared, %d unplaced, %d clusters, %d model calls",
             len(docs), len(groups), len(shared), len(report), len(clusters), calls)
    return {"groups": groups, "shared": shared, "clusters": clusters, "unplaced": report, "model_calls": calls}
