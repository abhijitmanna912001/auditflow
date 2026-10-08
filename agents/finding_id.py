"""Stable identifier for a single finding."""

from __future__ import annotations

import hashlib


def make_finding_id(finding_type: str, primary_document: str | None) -> str:
    """Return "AF-" plus the first 10 hex characters of
    sha256(f"{type}|{primary_document}").

    The id is deliberately built from only the finding type and the document
    it is anchored on. The list of documents a finding cites is NOT part of
    it: the model can cite a slightly different set of documents for the same
    underlying issue from one run to the next, and the id must stay the same
    so a reviewer's decision or a ticket can still be matched to the finding
    when the case is re-run.

    Limitation: two findings of the same type on the same primary document
    get the same base id. build_findings() (workpaper_agent.py) makes the
    later ones unique with "-2", "-3" suffixes in the order the Anomaly stage
    returned them, so those suffixed ids depend on that order and are only
    as stable as it is.
    """
    digest = hashlib.sha256(f"{finding_type}|{primary_document}".encode("utf-8"))
    return "AF-" + digest.hexdigest()[:10]
