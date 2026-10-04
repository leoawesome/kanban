import { useState } from "react";
import type { ClaudeSession, Status, TicketMode } from "./api";
import { useImagePaste } from "./imagePaste";
import { ModeToggle } from "./ModeToggle";
import { Modal } from "./Modal";
import { SessionPicker, sessionLabel } from "./SessionPicker";

export function NewTicketDialog({ slug, folder, onClose, onCreate }: {
  slug: string;
  folder: string;
  onClose: () => void;
  onCreate: (input: { title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode }) => Promise<void>;
}) {
  const [mode, setMode] = useState<TicketMode>("interview");
  const [session, setSession] = useState<ClaudeSession | null>(null);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const images = useImagePaste(setBody);

  // Start: an interview goes to Planning (questions now), "Just do it" goes to Ready (runs when a slot is free).
  const startStatus: Status = mode === "interview" ? "planning" : "ready";
  const startLabel = mode === "interview" ? "Start planning" : "Start now";

  const submit = async (status: Status) => {
    if (busy || !title.trim() || images.uploading) return;
    setBusy(true);
    try {
      await onCreate({ title: title.trim(), body, status, sessionId: session?.id, mode });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New ticket" onClose={onClose} guard={!busy && (!!title.trim() || !!body.trim())}>
      {/* Plain Enter in the title does nothing: starting a run should be deliberate (button or ⌘Enter). */}
      <form className="form" onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(startStatus); } }}>
        <div className="field">
          {session ? (
            <div className="session-chip">
              <span className="muted small">From session</span>
              <span className="session-title">{sessionLabel(session)}</span>
              <button type="button" className="link-btn" onClick={() => setSession(null)}>Remove</button>
            </div>
          ) : (
            <button type="button" className="link-btn" onClick={() => setPicking(true)}>Start from an existing Claude session…</button>
          )}
        </div>
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" />
        </label>
        <label>
          Description
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, acceptance criteria, links… (markdown). Paste or drop images."
            className={images.dragOver ? "drop-target" : undefined} {...images.handlers} />
          {images.error && <span className="form-error">{images.error}</span>}
        </label>
        <div className="field">
          <div className="field-label">How should Claude work?</div>
          <ModeToggle value={mode} onChange={setMode} />
          <span className="muted small">
            {mode === "interview"
              ? "Claude first asks clarifying questions in the chat, then does the work once you answer."
              : "Claude works on its own and reports back when done."}
          </span>
        </div>
        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy || !title.trim() || images.uploading} onClick={() => submit("backlog")} title="Park it in Backlog; nothing runs">Create</button>
          <button type="button" className="btn primary icon-label" onClick={() => submit(startStatus)} disabled={busy || !title.trim() || images.uploading}>
            {images.uploading ? "Uploading image…" : <>{startLabel} <kbd className="kbd-on-primary">⌘↵</kbd></>}
          </button>
        </div>
        <div className="muted small form-where">
          {mode === "interview"
            ? "Create → Backlog · Start planning → Planning (Claude asks questions now)"
            : "Create → Backlog · Start now → In Progress (queued if all slots busy)"}
        </div>
      </form>
      {picking && (
        <SessionPicker slug={slug} folder={folder} onClose={() => setPicking(false)} onPick={(s) => {
          setSession(s);
          if (!title.trim()) setTitle(s.title ?? s.firstPrompt?.slice(0, 80) ?? "");
          setPicking(false);
        }} />
      )}
    </Modal>
  );
}
