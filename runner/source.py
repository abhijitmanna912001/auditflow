"""Source slot: where documents come from. A real connector (Drive, S3, SharePoint, ...) is a
new subclass of Source; nothing else in the runner knows where files live."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path


class Source(ABC):
    @abstractmethod
    def list_files(self) -> list[str]:
        """Stable, sorted list of file names (opaque ids within this source)."""

    @abstractmethod
    def read_file(self, name: str) -> bytes:
        """Raw bytes of one file returned by list_files()."""


class LocalFolderSource(Source):
    """Every regular, non-hidden file directly inside one folder."""

    def __init__(self, folder: str | Path):
        self.folder = Path(folder)
        if not self.folder.is_dir():
            raise FileNotFoundError(f"Source folder not found: {self.folder}")

    def list_files(self) -> list[str]:
        return sorted(p.name for p in self.folder.iterdir() if p.is_file() and not p.name.startswith("."))

    def read_file(self, name: str) -> bytes:
        path = (self.folder / name).resolve()
        if path.parent != self.folder.resolve():          # no path tricks out of the folder
            raise ValueError("file name must be a plain name inside the source folder")
        return path.read_bytes()
