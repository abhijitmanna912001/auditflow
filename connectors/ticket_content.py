"""Pure helpers that turn a finding into ticket content. No network."""

from __future__ import annotations

import html
import re
import unicodedata

MAX_SUBJECT_LENGTH = 255
MAX_FILE_BYTES = 19_000_000
MAX_TICKET_BYTES = 50_000_000

CLOSING_SENTENCE = (
    "This is a document check result for the auditor to review. "
    "It is not a conclusion about fraud or compliance."
)

_KEY_RE = re.compile(r"^\[(AF-[0-9a-f]{10}(?:-\d+)?)\]")


def normalise_company(name: str) -> tuple[str, str]:
    """Return (display_name, match_key): trimmed, whitespace collapsed; the
    key is also casefolded."""
    display = " ".join(str(name).split())
    if not display:
        raise ValueError("company name is empty")
    return display, display.casefold()


def _clean_line(text) -> str:
    """Replace newlines and control characters with spaces, collapse spaces."""
    chars = []
    for ch in str(text):
        category = unicodedata.category(ch)
        chars.append(" " if category in ("Cc", "Cf", "Zl", "Zp") else ch)
    return " ".join("".join(chars).split())


def build_subject(finding_id: str, label: str, primary_document: str) -> str:
    """"[<finding_id>] <label> – <primary_document>", at most 255 characters.
    The key is always first; only the text after it is cut."""
    prefix = f"[{_clean_line(finding_id)}] "
    rest = f"{_clean_line(label)} – {_clean_line(primary_document)}"
    return (prefix + rest)[:MAX_SUBJECT_LENGTH].rstrip()


def extract_key(subject) -> str | None:
    """The finding id in the leading "[AF-...]" token of a subject, or None."""
    if not isinstance(subject, str):
        return None
    match = _KEY_RE.match(subject)
    return match.group(1) if match else None


def find_existing_ticket(tickets, finding_id: str) -> dict | None:
    """First ticket whose subject key equals finding_id exactly."""
    for ticket in tickets:
        if extract_key(ticket.get("subject")) == finding_id:
            return ticket
    return None


def _cited_documents(finding: dict) -> list[str]:
    docs = finding.get("documents") or finding.get("transaction_documents") or []
    return list(dict.fromkeys(docs))


def plan_attachments(
    finding: dict,
    documents_map: list[dict],
    ambiguous_doc_ids,
    file_sizes: dict[str, int],
) -> dict:
    """Decide which uploaded files go on the ticket.

    Documents are the finding's cited documents, else its transaction
    documents (deduped, cited order). Files come from `documents_map`
    ([{doc_id, source_file}]); a file counts only if it is in `file_sizes`.
    A doc id listed in `ambiguous_doc_ids` attaches every candidate file.
    Files are considered in order; one that is over the per-file limit, or
    would push the ticket over its total, is skipped and the rest still tried.

    Returns {doc_ids, attach, not_attached_size, no_file, ambiguous}; every
    entry carries a reason. `attach` entries also list the doc ids they were
    linked through.
    """
    ambiguous_set = set(ambiguous_doc_ids or [])
    doc_ids = _cited_documents(finding)

    files_by_doc: dict[str, list[str]] = {}
    for entry in documents_map or []:
        source = entry.get("source_file")
        if source is not None and source in file_sizes:
            files = files_by_doc.setdefault(entry.get("doc_id"), [])
            if source not in files:
                files.append(source)

    ordered_files: list[str] = []
    docs_for_file: dict[str, list[str]] = {}
    no_file: list[dict] = []
    ambiguous: list[dict] = []
    for doc_id in doc_ids:
        files = files_by_doc.get(doc_id, [])
        if not files:
            no_file.append({"doc_id": doc_id, "reason": "no uploaded file was read as this document"})
            continue
        if doc_id in ambiguous_set or len(files) > 1:
            ambiguous.append(
                {
                    "doc_id": doc_id,
                    "files": list(files),
                    "reason": "this document id was found in more than one file; all of them are attached",
                }
            )
        for name in files:
            if name not in docs_for_file:
                ordered_files.append(name)
                docs_for_file[name] = []
            if doc_id not in docs_for_file[name]:
                docs_for_file[name].append(doc_id)

    attach: list[dict] = []
    not_attached_size: list[dict] = []
    total = 0
    for name in ordered_files:
        size = file_sizes[name]
        if size > MAX_FILE_BYTES:
            reason = f"file is larger than {MAX_FILE_BYTES:,} bytes"
        elif total + size > MAX_TICKET_BYTES:
            reason = f"ticket attachments would exceed {MAX_TICKET_BYTES:,} bytes"
        else:
            total += size
            attach.append(
                {
                    "filename": name,
                    "size": size,
                    "doc_ids": docs_for_file[name],
                    "reason": "linked to a cited document",
                }
            )
            continue
        not_attached_size.append(
            {"filename": name, "size": size, "doc_ids": docs_for_file[name], "reason": reason}
        )

    return {
        "doc_ids": doc_ids,
        "attach": attach,
        "not_attached_size": not_attached_size,
        "no_file": no_file,
        "ambiguous": ambiguous,
    }


def _e(value) -> str:
    return html.escape(str(value), quote=True)


def _list(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{item}</li>" for item in items) + "</ul>"


def build_description(finding: dict, company: str, plan: dict) -> str:
    """HTML ticket body using only p, br, b, ul and li. Every piece of
    dynamic text is HTML-escaped."""
    primary = finding.get("primary_document")
    related = [d for d in plan.get("doc_ids", []) if d != primary]

    parts = [
        f"<p><b>Audit exception:</b> {_e(finding.get('label', ''))}</p>",
        f"<p><b>Company:</b> {_e(company)}</p>",
        f"<p><b>Document:</b> {_e(primary)}</p>",
        f"<p><b>Related documents:</b> {_e(', '.join(related)) if related else 'None'}</p>",
        f"<p><b>Why it was flagged:</b><br>{_e(finding.get('explanation', ''))}</p>",
    ]

    lines: list[str] = []
    if plan.get("attach"):
        lines.append("Attached: " + _e(", ".join(a["filename"] for a in plan["attach"])))
    for item in plan.get("not_attached_size", []):
        lines.append(f"Not attached because of size: {_e(item['filename'])} ({_e(item['reason'])})")
    for item in plan.get("no_file", []):
        lines.append(f"Not uploaded: no file for {_e(item['doc_id'])}")
    for item in plan.get("ambiguous", []):
        lines.append(
            f"Ambiguous: {_e(item['doc_id'])} was found in {_e(', '.join(item['files']))}"
        )
    if not lines:
        lines.append("No files attached")
    parts.append("<p><b>Attachments:</b></p>" + _list(lines))

    linked = [
        f"{_e(a['filename'])}: Linked because AuditFlow read it as {_e(doc_id)}"
        for a in plan.get("attach", [])
        for doc_id in a.get("doc_ids", [])
    ]
    if linked:
        parts.append(_list(linked))

    parts.append(f"<p>{_e(CLOSING_SENTENCE)}</p>")
    return "".join(parts)
