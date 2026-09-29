import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeSession } from "./api";
import { Modal } from "./Modal";
import { timeAgo } from "./time";

export function sessionLabel(s: Pick<ClaudeSession, "title" | "firstPrompt" | "id">): string {
  return s.title ?? s.firstPrompt ?? s.id.slice(0, 8);
}

export function SessionPicker({ slug, folder, currentTicketId, onPick, onClose }: {
  slug: string;
  folder: string;
  currentTicketId?: string;
  onPick: (s: ClaudeSession) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.sessions(slug).then(setSessions).catch((e) => setErr(e.message));
  }, [slug]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !sessions) return sessions ?? [];
    return sessions.filter((s) => `${s.title ?? ""} ${s.firstPrompt ?? ""} ${s.id}`.toLowerCase().includes(needle));
  }, [sessions, q]);

  return (
    <Modal title="Link a Claude Code session" onClose={onClose} wide>
      <div className="form">
        <p className="muted small" style={{ margin: 0 }}>
          Sessions you started in <code>{folder}</code>. Linking lets this ticket continue that conversation.
        </p>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or first message…" />
        <div className="picker-list sessions" role="listbox">
          {err && <div className="picker-empty">{err}</div>}
          {!err && sessions === null && <div className="picker-empty">Loading…</div>}
          {sessions !== null && shown.length === 0 && (
            <div className="picker-empty">{sessions.length ? "No match." : "No Claude Code sessions found in this folder."}</div>
          )}
          {shown.map((s) => {
            const takenByOther = s.ticket && s.ticket.id !== currentTicketId;
            return (
              <button key={s.id} type="button" className="session-row" disabled={!!takenByOther} onClick={() => onPick(s)}
                title={takenByOther ? `Already linked to "${s.ticket!.title}"` : s.id}>
                <div className="session-main">
                  <span className="session-title">{sessionLabel(s)}</span>
                  {s.title && s.firstPrompt && <span className="session-sub">{s.firstPrompt}</span>}
                </div>
                <div className="session-meta">
                  {s.live && <span className="badge running"><span className="live-dot" /> open in terminal</span>}
                  {s.ticket && <span className="badge stopped">{takenByOther ? `linked: ${s.ticket.title}` : "this ticket"}</span>}
                  <span className="muted small">{timeAgo(s.lastActive)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
