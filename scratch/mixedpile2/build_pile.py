"""Rebuild the pile with re-keyed document IDs (no numeric series shared across types or cases).

Every document ID mentioned anywhere in the 14 cases (including citations of documents that do not
exist, e.g. the PO that CASE_05 never had) gets a fresh random 5-digit number in its own type series,
replaced consistently in every text. Also builds the extras: 3 distractors (variant C) and one
multi-payment bank statement. Writes answer_key.json, read ONLY by compare.py."""
import json, random, re, shutil
from pathlib import Path

ROOT = Path(__file__).parent
DATASET = ROOT.parent.parent / "dataset"
ID_RE = re.compile(r"\b(PO|INV|REC|BNK|LED)-(\d{4})(-[AB])?\b")
rng = random.Random(20260930)

srcs = sorted(p for c in sorted(DATASET.glob("CASE_*")) if c.is_dir() for p in c.glob("*.txt"))
texts = {p: p.read_text() for p in srcs}

used = set()
def fresh(prefix):
    while True:
        n = rng.randint(10000, 99999)
        if (prefix, n) not in used:
            used.add((prefix, n))
            return f"{prefix}-{n}"

idmap = {}     # old full id (e.g. INV-1003-A) -> new id
def remap(old):
    if old not in idmap:
        idmap[old] = fresh(old.split("-")[0])
    return idmap[old]

for p in srcs:                                   # assign in stable order
    for m in ID_RE.finditer(texts[p]):
        remap(m.group(0))
def rekey(t):
    return ID_RE.sub(lambda m: idmap[m.group(0)], t)

docs = []      # (new text, truth, old file name, new doc id)
for p in srcs:
    old_id = p.stem
    docs.append((rekey(texts[p]), p.parent.name, p.name, idmap[old_id]))
rng.shuffle(docs)

for d in ("pile", "batches", "extras"):
    if (ROOT / d).exists():
        shutil.rmtree(ROOT / d)
for d in ("pile", "extras"):
    (ROOT / d).mkdir()

key = {}
for i, (text, case, orig, new_id) in enumerate(docs, 1):
    name = f"doc_{i:03d}.txt"
    (ROOT / "pile" / name).write_text(text)
    key[name] = {"truth": case, "original": orig, "new_id": new_id}

# ---- extras -------------------------------------------------------------------------------
d1, d2, dpo = fresh("INV"), fresh("INV"), fresh("PO")
ref1, ref2 = fresh("PO"), fresh("PO")      # POs the two distractor invoices cite; no such documents exist
inv_tpl = """TAX INVOICE
Document ID: {id}
Supplier Invoice No: {sup}
Invoice Date: {date}
Vendor: Horizon Office Systems Pvt. Ltd.
Bill To: AuditFlow Operations, Bengaluru
PO Reference: {po}

Description: {desc}
Quantity: {qty}
Subtotal: INR {sub}
GST @ 18%: INR {gst}
Invoice Total: INR {tot}

Payment Terms: Net 30 days from invoice date.
"""
extras = {
    "dist_inv1": (inv_tpl.format(id=d1, sup="HOS/2026-27/131", date="2026-07-06", po=ref1,
        desc="Ergonomic task chairs, mesh back", qty="10 units at INR 3,975.00 each",
        sub="39,750.00", gst="7,155.00", tot="46,905.00"), "DIST_1"),
    "dist_inv2": (inv_tpl.format(id=d2, sup="HOS/2026-27/137", date="2026-07-12", po=ref2,
        desc="Height-adjustable desks, walnut top", qty="5 units at INR 8,050.00 each",
        sub="40,250.00", gst="7,245.00", tot="47,495.00"), "DIST_2"),
    "dist_po": (f"""PURCHASE ORDER
Purchase Order No: {dpo}
Issue Date: 2026-08-04
Supplier: CloudDesk Software India Pvt. Ltd.
Ship To: AuditFlow Finance Team, Bengaluru

Description: Collaboration software add-on licences, 18 users
Subscription Period: 2026-08-01 to 2027-07-31
Subtotal: INR 79,000.00
GST @ 18%: INR 14,220.00
Purchase Order Total: INR 93,220.00

Payment Terms: Net 30 days from accepted invoice.
Authorized by: Head of Finance
""", "DIST_PO"),
}
mp_id = fresh("BNK")
def new(old): return idmap[old]
mp = f"""BANK STATEMENT EXTRACT
Transaction Reference: {mp_id}
Account Holder: AuditFlow Operations
Statement Period: 2026-07-01 to 2026-09-30
Payments listed: 4

1. Date: 2026-07-10 | Beneficiary: Vertex Print Solutions Pvt. Ltd. | NEFT payment against {new('INV-1004')} / {new('PO-1004')} | Debit: INR 82,500.00
2. Date: 2026-07-25 | Beneficiary: Horizon Office Systems Pvt. Ltd. | NEFT payment against {new('INV-1001')} and {new('PO-1001')} | Debit: INR 47,200.00
3. Date: 2026-09-01 | Beneficiary: CloudDesk Software India Pvt. Ltd. | NEFT settlement of {new('INV-1002')} / {new('PO-1002')} | Debit: INR 94,400.00
4. Date: 2026-09-03 | Beneficiary: BluePeak Training Services Pvt. Ltd. | NEFT settlement of {new('INV-1008')} / {new('PO-1008')} | Debit: INR 106,200.00

Status: All payments successful
"""
extras["mp_statement"] = (mp, "MULTI:CASE_01,CASE_02,CASE_04,CASE_08")
order = list(extras)
rng.shuffle(order)
n = len(docs)
for k, name in enumerate(order, 1):
    fn = f"doc_{n + k:03d}.txt"
    (ROOT / "extras" / fn).write_text(extras[name][0])
    key[fn] = {"truth": extras[name][1], "original": name, "new_id": {"dist_inv1": d1, "dist_inv2": d2, "dist_po": dpo, "mp_statement": mp_id}[name]}
(ROOT / "answer_key.json").write_text(json.dumps({"files": key, "idmap": idmap}, indent=1))

# ---- batches ------------------------------------------------------------------------------
names = sorted(p.name for p in (ROOT / "pile").iterdir())
for b in range(0, len(names), 10):
    f = ROOT / "batches" / f"BATCH_{b // 10 + 1:02d}"
    f.mkdir(parents=True)
    for nme in names[b:b + 10]:
        shutil.copyfile(ROOT / "pile" / nme, f / nme)
for label, pick in (("BATCH_DIST", [n_ for n_ in order if n_ != "mp_statement"]), ("BATCH_MP", ["mp_statement"])):
    f = ROOT / "batches" / label
    f.mkdir(parents=True)
    for name in pick:
        fn = f"doc_{n + order.index(name) + 1:03d}.txt"
        shutil.copyfile(ROOT / "extras" / fn, f / fn)
print(len(docs), "core docs;", len(extras), "extras;", len(idmap), "ids remapped")
