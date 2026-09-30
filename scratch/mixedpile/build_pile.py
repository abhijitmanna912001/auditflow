"""Step 1: flat shuffled pile of all 67 benchmark documents + answer key + batch folders.
The answer key is written here and read ONLY by compare.py."""
import json, random, shutil
from pathlib import Path

ROOT = Path(__file__).parent
DATASET = ROOT.parent.parent / "dataset"
BATCH = 10

docs = sorted(p for c in sorted(DATASET.glob("CASE_*")) if c.is_dir() for p in c.glob("*.txt"))
random.Random(20260930).shuffle(docs)

for d in ("pile", "batches"):
    if (ROOT / d).exists():
        shutil.rmtree(ROOT / d)
(ROOT / "pile").mkdir()

key = {}
for i, src in enumerate(docs, 1):
    name = f"doc_{i:03d}.txt"
    shutil.copyfile(src, ROOT / "pile" / name)          # text byte-for-byte unchanged
    key[name] = {"case": src.parent.name, "original": src.name}
(ROOT / "answer_key.json").write_text(json.dumps(key, indent=1))

names = sorted(key)
for b in range(0, len(names), BATCH):
    folder = ROOT / "batches" / f"BATCH_{b // BATCH + 1:02d}"
    folder.mkdir(parents=True)
    for n in names[b:b + BATCH]:
        shutil.copyfile(ROOT / "pile" / n, folder / n)
print(len(names), "docs,", len(list((ROOT / "batches").iterdir())), "batches")
