"""Build scratch cases from dataset/CASE_01 (IDs 1001 -> 91xx), dropping documents."""
import re, shutil
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT.parent.parent / "dataset" / "CASE_01"
# case folder -> (new id number, documents to drop, ids of dropped docs to scrub from refs)
CASES = {
    "CASE_91": ("9101", {"PO"}),                    # a. no PO
    "CASE_92": ("9102", {"REC"}),                   # b. no receipt
    "CASE_93": ("9103", {"BNK"}),                   # c. no bank statement
    "CASE_94": ("9104", {"PO", "REC", "BNK"}),      # d. only invoice + ledger
}
# Convention from CASE_05/CASE_12: an invoice keeps citing its PO (that is what makes
# a missing PO meaningful); the ledger's Supporting Documents list only what exists.
for folder, (num, drop) in CASES.items():
    out = ROOT / "cases" / folder
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for f in SRC.glob("*.txt"):
        prefix = f.name.split("-")[0]
        if prefix in drop:
            continue
        text = f.read_text().replace("1001", num)
        if prefix == "LED":
            present = [p for p in ("PO", "INV", "REC", "BNK") if p not in drop]
            text = re.sub(r"Supporting Documents:.*",
                          "Supporting Documents: " + ", ".join(f"{p}-{num}" for p in present), text)
        if prefix == "BNK":
            pass
        (out / f.name.replace("1001", num)).write_text(text)
