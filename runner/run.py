"""Run manager: source -> Intake (per file) -> grouping -> pipeline per group -> one ticket per finding.

    set -a; source .env; set +a          # ANTHROPIC_API_KEY in the environment; never written anywhere
    python -m runner.run --source <folder> --out <folder>

Logs ids and counts only, never document text or keys. Nothing is kept after a run except the run
record, the tickets and the unplaced report under --out.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import pipeline
from .grouping import group_documents
from .sink import LocalTicketSink, TicketSink
from .source import LocalFolderSource, Source
from .tickets import build_ticket, content_hash, finding_id

log = logging.getLogger("runner")
SUPPORTED = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}
INTAKE_WORKERS = 4


def _err(e: Exception) -> str:
    """Error text for logs/records: exception type and HTTP status only (messages could echo content)."""
    status = getattr(e, "status_code", None)
    return type(e).__name__ + (f" (HTTP {status})" if status else "")


def run_audit(source: Source, sink: TicketSink, out_dir: str | Path, run_id: str | None = None) -> dict:
    out = Path(out_dir)
    run_id = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    run_dir = out / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    record = {"run_id": run_id, "status": "running", "started_at": datetime.now(timezone.utc).isoformat(),
              "files": [], "files_processed": 0, "groups": [], "findings": [], "tickets_created": [],
              "tickets_existing": [], "clean_groups": [], "unplaced": [], "errors": []}
    unplaced: list[dict] = []

    def save():
        (run_dir / "run_record.json").write_text(json.dumps(record, indent=2))

    try:
        names = source.list_files()
        record["files"] = names
        log.info("run %s: %d files", run_id, len(names))
        data: dict[str, bytes] = {}
        for n in names:
            if Path(n).suffix.lower() not in SUPPORTED:
                unplaced.append({"file": n, "doc_id": None, "reason": "unsupported file type", "cluster": None})
                continue
            data[n] = source.read_file(n)
        hashes = {n: content_hash(b) for n, b in data.items()}

        # -- Intake, one file at a time so every document is tied to its file ------------------
        def do_intake(n):
            try:
                return n, pipeline.intake_one(n, data[n]), None
            except Exception as e:                     # noqa: BLE001 - recorded, run continues
                return n, [], _err(e)
        docs, file_of = [], {}
        with ThreadPoolExecutor(INTAKE_WORKERS) as ex:
            for n, ds, err in ex.map(do_intake, sorted(data)):
                if err:
                    record["errors"].append({"stage": "intake", "file": n, "error": err})
                    unplaced.append({"file": n, "doc_id": None, "reason": f"intake failed: {err}", "cluster": None})
                    continue
                if not ds:
                    unplaced.append({"file": n, "doc_id": None, "reason": "no document found in file", "cluster": None})
                for d in ds:
                    if d["doc_id"] in file_of:
                        unplaced.append({"file": n, "doc_id": d["doc_id"], "cluster": None,
                                         "reason": f"duplicate document id (also in {file_of[d['doc_id']]})"})
                        continue
                    d["_file"] = n
                    file_of[d["doc_id"]] = n
                    docs.append(d)
        record["files_processed"] = len({d["_file"] for d in docs})
        log.info("intake: %d documents from %d files", len(docs), record["files_processed"])
        by_id = {d["doc_id"]: d for d in docs}
        if not docs:
            raise RuntimeError("no documents could be read")

        # -- grouping -----------------------------------------------------------------------
        res = group_documents([{k: v for k, v in d.items() if k != "_file"} for d in docs])
        for u in res["unplaced"]:
            unplaced.append({"file": file_of.get(u["doc_id"]), "doc_id": u["doc_id"],
                             "reason": u["reason"], "cluster": u["cluster"]})
        record["groups"] = [{"group": g, "doc_ids": v["members"], "shared": v["shared"]}
                            for g, v in res["groups"].items()]
        record["clusters"] = res["clusters"]
        save()

        # -- pipeline per group, then tickets -----------------------------------------------
        seen_this_run: set[str] = set()
        for g, v in res["groups"].items():
            member_files = sorted({file_of[m] for m in v["members"]})
            try:
                out_g = pipeline.run_group(g, [(n, data[n]) for n in member_files])
            except Exception as e:                     # noqa: BLE001
                record["errors"].append({"stage": "pipeline", "group": g, "error": _err(e)})
                log.error("group %s pipeline failed: %s", g, _err(e))
                continue
            findings = out_g["decision"]["findings"]
            log.info("group %s: %d docs, %d findings, action=%s", g, len(v["members"]), len(findings),
                     out_g["decision"]["action"])
            if not findings:
                record["clean_groups"].append(g)
            for f in findings:
                cited, missing = [], []
                for did in f["documents"]:
                    (cited if did in by_id and by_id[did]["_file"] in data else missing).append(did)
                cited_docs = [by_id[i] for i in cited]
                attach_names = sorted({d["_file"] for d in cited_docs})
                fid = finding_id(f["type"], [hashes[n] for n in attach_names])
                entry = {"finding_id": fid, "group": g, "type": f["type"], "documents": f["documents"],
                         "severity": f["severity"], "attachments": attach_names, "unmatched_documents": missing}
                if missing:
                    record["errors"].append({"stage": "attachments", "finding": fid, "unmatched": missing})
                record["findings"].append(entry)
                if fid in seen_this_run:
                    continue
                seen_this_run.add(fid)
                existing = sink.find_existing(fid)
                if existing:
                    record["tickets_existing"].append(existing)
                    continue
                title, body = build_ticket(f, cited_docs, missing)
                tid = sink.create_ticket(title, body, [(n, data[n]) for n in attach_names], fid)
                record["tickets_created"].append(tid)
                log.info("ticket %s created (%s, %d attachments)", tid, f["type"], len(attach_names))
            save()
        record["status"] = "completed_with_errors" if record["errors"] else "completed"
    except Exception as e:                             # noqa: BLE001
        record["status"] = "failed"
        record["errors"].append({"stage": "run", "error": _err(e)})
        log.error("run failed: %s", _err(e))
    finally:
        record["unplaced"] = unplaced
        record["finished_at"] = datetime.now(timezone.utc).isoformat()
        (run_dir / "unplaced_report.json").write_text(json.dumps(
            {"run_id": run_id, "count": len(unplaced), "documents": unplaced}, indent=2))
        save()
    log.info("run %s: %s; findings=%d tickets_created=%d existing=%d unplaced=%d errors=%d", run_id,
             record["status"], len(record["findings"]), len(record["tickets_created"]),
             len(record["tickets_existing"]), len(unplaced), len(record["errors"]))
    return record


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="AuditFlow audit run (local folder -> local tickets)")
    ap.add_argument("--source", required=True, help="folder of PDF/image documents")
    ap.add_argument("--out", required=True, help="output folder (tickets/, runs/<id>/)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", stream=sys.stderr)
    for noisy in ("httpx", "httpx2", "httpcore", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    rec = run_audit(LocalFolderSource(args.source), LocalTicketSink(args.out), args.out)
    print(json.dumps({k: rec[k] for k in ("run_id", "status", "files_processed")}
                     | {"groups": len(rec["groups"]), "findings": len(rec["findings"]),
                        "tickets_created": len(rec["tickets_created"]), "tickets_existing": len(rec["tickets_existing"]),
                        "unplaced": len(rec["unplaced"]), "errors": len(rec["errors"])}))
    return 0 if rec["status"] in ("completed", "completed_with_errors") else 1


if __name__ == "__main__":
    raise SystemExit(main())
