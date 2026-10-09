"""Pure helpers that tie uploaded files to the documents Intake read from them."""

from __future__ import annotations

import os


def make_unique_filenames(names: list[str]) -> list[str]:
    """Return `names` with repeats made unique, keeping order and length.

    The first use of a name is kept as is; later repeats become "a (2).pdf",
    "a (3).pdf", ... The counter goes before the extension so the file type
    is still readable from the end of the name. A generated name never
    collides with any other name in the list.
    """
    out: list[str | None] = [None] * len(names)
    seen: set[str] = set()
    for i, name in enumerate(names):
        if name not in seen:
            seen.add(name)
            out[i] = name
    taken = set(names)
    for i, name in enumerate(names):
        if out[i] is not None:
            continue
        stem, ext = os.path.splitext(name)
        counter = 2
        while f"{stem} ({counter}){ext}" in taken:
            counter += 1
        out[i] = f"{stem} ({counter}){ext}"
        taken.add(out[i])
    return out  # type: ignore[return-value]


def build_file_map(intake_documents: list[dict], uploaded_filenames: list[str]) -> dict:
    """Map doc ids to the uploaded files they were read from.

    Returns:
      documents: [{doc_id, source_file}] in Intake order. One file holding
        several documents gives several entries; one doc id found in two
        files gives two entries. An identical (doc_id, source_file) pair is
        listed once. A document whose source_file is missing or is not one of
        the uploaded filenames gets source_file None.
      ambiguous_doc_ids: doc ids found in two or more different files.
      unmapped_files: uploaded files no document was read from, in upload order.
    """
    uploaded = set(uploaded_filenames)
    documents: list[dict] = []
    pairs: set[tuple[str, str | None]] = set()
    files_by_doc: dict[str, list[str]] = {}
    used_files: set[str] = set()

    for doc in intake_documents:
        doc_id = doc.get("doc_id")
        source = doc.get("source_file")
        if source not in uploaded:
            source = None
        if (doc_id, source) in pairs:
            continue
        pairs.add((doc_id, source))
        documents.append({"doc_id": doc_id, "source_file": source})
        if source is not None:
            used_files.add(source)
            files_by_doc.setdefault(doc_id, []).append(source)

    ambiguous = [doc_id for doc_id, files in files_by_doc.items() if len(set(files)) > 1]
    unmapped = [name for name in uploaded_filenames if name not in used_files]
    return {
        "documents": documents,
        "ambiguous_doc_ids": ambiguous,
        "unmapped_files": unmapped,
    }
