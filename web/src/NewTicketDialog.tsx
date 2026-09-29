import { useState } from "react";
import { COLUMNS, type Status } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";

const ALLOWED = COLUMNS.filter((c) => c.id !== "in_progress" && c.id !== "done");

export function NewTicketDialog({ initialStatus, onClose, onCreate }: {
  initialStatus: Status;
  onClose: () => void;
  onCreate: (input: { title: string; body: string; status: Status }) => Promise<void>;
}) {
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
      await onCreate({ title: title.trim(), body, status });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New ticket" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" />
        </label>
        <label>
          Description
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, acceptance criteria, links… (markdown)"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
        </label>
        <label>
          Column
          <Select
            ariaLabel="Column"
            value={status}
            onChange={(s) => setStatus(s as Status)}
            options={ALLOWED.map((c) => ({ value: c.id, label: c.label, hint: c.id === "ready" ? "Claude starts right away" : c.hint }))}
          />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>Create</button>
        </div>
      </form>
    </Modal>
  );
}
