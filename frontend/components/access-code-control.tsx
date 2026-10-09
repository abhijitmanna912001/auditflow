"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  clearAccessCode,
  hasAccessCode,
  saveAccessCode,
} from "../lib/api-client";

interface AccessCodeControlProps {
  readonly onChange: () => void;
}

export function AccessCodeControl({ onChange }: AccessCodeControlProps) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSaved(hasAccessCode());
  }, []);

  const closePanel = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.trim()) return;
    if (saveAccessCode(draft)) {
      setSaved(true);
      setNotice(null);
      setDraft("");
      closePanel();
      onChange();
    } else {
      setNotice("This browser can't keep the access code, so it wasn't saved.");
    }
  };

  const clear = () => {
    clearAccessCode();
    setSaved(false);
    setDraft("");
    setNotice(null);
    onChange();
  };

  return (
    <div className="access-code" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="access-code-toggle"
        aria-expanded={open}
        aria-controls="access-code-panel"
        onClick={() => setOpen((current) => !current)}
      >
        {saved ? "Access code saved" : "Access code"}
      </button>
      {open && (
        <form
          className="access-code-panel"
          id="access-code-panel"
          role="dialog"
          aria-label="Access code"
          onSubmit={save}
        >
          <label htmlFor="access-code-input">Access code</label>
          <input
            id="access-code-input"
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p>Enter the access code you were given. It stays in this browser tab only.</p>
          {saved && <p className="access-code-saved">Access code saved</p>}
          {notice && <p className="access-code-notice">{notice}</p>}
          <div className="access-code-actions">
            <button type="submit" className="access-code-btn access-code-btn-solid" disabled={!draft.trim()}>
              Save
            </button>
            <button type="button" className="access-code-btn access-code-btn-outline" onClick={clear}>
              Clear
            </button>
            <button type="button" className="access-code-btn access-code-btn-outline" onClick={closePanel}>
              Close
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
