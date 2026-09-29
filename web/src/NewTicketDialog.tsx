import { useState } from "react";
import { COLUMNS, type ClaudeSession, type Status, type TicketMode } from "./api";
import { ModeToggle } from "./ModeToggle";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { SessionPicker, sessionLabel } from "./SessionPicker";

const ALLOWED = COLUMNS.filter((c) => c.id !== "in_progress" && c.id !== "done");

export function NewTicketDialog({ slug, folder, initialStatus, onClose, onCreate }: {
  slug: string;
  folder: string;
  initialStatus: Status;
  onClose: () => void;
  onCreate: (input: { title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode }) => Promise<void>;
}) {
  const [mode, setMode] = useState<TicketMode>("interview");
  const [session, setSession] = useState<ClaudeSession | null>(null);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<Status>(ALLOWED.some((c) => c.id === initialStatus) ? initialStatus : "backlog");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onCreate({ title: title.trim(), body, status, sessionId: session?.id, mode });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New ticket" onClose={onClose}>
      <form className="form" onSubmit={submit}>
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
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, acceptance criteria, links… (markdown)"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
        </label>
        <div className="field">
          <div className="field-label">How should Claude work?</div>
          <ModeToggle value={mode} onChange={setMode} />
          <span className="muted small">
            {mode === "interview"
              ? "Claude first asks clarifying questions in the comments, then does the work once you answer."
              : "Claude works on its own and reports back when done."}
          </span>
        </div>
        <label>
          Column
          <Select
            ariaLabel="Column"
            value={status}
            onChange={(s) => setStatus(s as Status)}
            options={ALLOWED.map((c) => ({ value: c.id, label: c.label, hint: c.id === "ready" ? "Claude starts working right away" : c.id === "planning" ? "Claude starts asking you questions right away" : c.id === "backlog" ? "Just park it; nothing runs" : c.hint }))}
          />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>Create</button>
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
