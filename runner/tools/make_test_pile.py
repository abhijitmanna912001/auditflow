"""TEST HELPER (needs reportlab, installed in the venv only; not in requirements.txt).
Turns the .txt fixtures of chosen benchmark cases into text PDFs with neutral names in one folder.
The answer key (neutral name -> case) goes to --key, OUTSIDE the pile.
    python -m runner.tools.make_test_pile dataset OUT_DIR KEY.json CASE_01 CASE_05 ..."""
import json, random, sys
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def to_pdf(text: str, path: Path):
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Courier", 10)
    y = 800
    for line in text.splitlines():
        c.drawString(50, y, line[:95])
        y -= 14
    c.save()


def main(dataset, out_dir, key_path, *cases, seed=20261001):
    docs = [(c, p) for c in cases for p in sorted((Path(dataset) / c).glob("*.txt"))]
    random.Random(seed).shuffle(docs)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    key = {}
    for i, (c, p) in enumerate(docs, 1):
        name = f"doc_{i:03d}.pdf"
        to_pdf(p.read_text(), out / name)
        key[name] = {"case": c, "original": p.name}
    Path(key_path).write_text(json.dumps(key, indent=1))
    print(len(docs), "PDFs ->", out)


if __name__ == "__main__":
    main(*sys.argv[1:])
