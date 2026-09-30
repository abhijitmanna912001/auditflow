"""Ticket destination slot. A real connector (Jira, Linear, ServiceNow, ...) is a new subclass of
TicketSink; the run manager only calls find_existing() and create_ticket()."""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path

Attachment = tuple[str, bytes]      # (file name, raw bytes)


class TicketSink(ABC):
    @abstractmethod
    def find_existing(self, finding_id: str) -> str | None:
        """Return the id of a ticket already created for this finding id, else None."""

    @abstractmethod
    def create_ticket(self, title: str, body: str, attachments: list[Attachment], finding_id: str) -> str:
        """Create one ticket, attach the files, and return the new ticket id."""


class LocalTicketSink(TicketSink):
    """tickets/<finding_id>.json plus tickets/<finding_id>/attachments/<file>. The finding id is the
    ticket id, so find_existing() is a file-exists check that survives between runs."""

    def __init__(self, out_dir: str | Path):
        self.root = Path(out_dir) / "tickets"
        self.root.mkdir(parents=True, exist_ok=True)

    def find_existing(self, finding_id: str) -> str | None:
        return finding_id if (self.root / f"{finding_id}.json").is_file() else None

    def create_ticket(self, title: str, body: str, attachments: list[Attachment], finding_id: str) -> str:
        att_dir = self.root / finding_id / "attachments"
        att_dir.mkdir(parents=True, exist_ok=True)
        names = []
        for name, data in attachments:
            safe = Path(name).name
            (att_dir / safe).write_bytes(data)
            names.append(safe)
        ticket = {"ticket_id": finding_id, "finding_id": finding_id, "title": title, "body": body,
                  "attachments": names, "created_at": datetime.now(timezone.utc).isoformat()}
        (self.root / f"{finding_id}.json").write_text(json.dumps(ticket, indent=2))
        return finding_id
