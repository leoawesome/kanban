import { useEffect, useState } from "react";
import { api, copy, COLUMNS, subscribe, type ActivityEntry, type Comment, type Profile, type Status, type Ticket } from "./api";
import { outcomeBadge } from "./Card";
import { Markdown, Transcript } from "./Transcript";

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function TicketDrawer({ profile, ticket, onClose, onError }: {
  profile: Profile;
  ticket: Ticket;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const slug = profile.slug;
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [editing, setEditing] = useState(!ticket.body.trim());
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"comments" | "transcript">(ticket.status === "in_progress" ? "transcript" : "comments");
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const running = ticket.status === "in_progress";

  const reloadComments = () => api.comments(slug, ticket.id).then(setComments).catch(() => {});

  useEffect(() => {
    reloadComments();
    api.activity(slug, ticket.id).then(setActivity).catch(() => {});
    // Claude may rewrite the body during planning; fetch fresh copy on open.
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setTitle(t.title); }).catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, ticket.id]);

  useEffect(() => subscribe((e) => {
    if (e.type === "activity" && e.profile === slug && e.id === ticket.id) {
      setActivity((a) => [...a, { run: e.run, at: new Date().toISOString(), event: e.event }]);
    }
    if (e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticket.id) reloadComments();
  }), [slug, ticket.id]);

  useEffect(() => {
    if (!editing) setBody(ticket.body);
  }, [ticket.body]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    }
  };

  const saveTitle = () => {
    if (title.trim() && title !== ticket.title) act(() => api.updateTicket(slug, ticket.id, { title: title.trim() }));
  };
  const saveBody = () => {
    setEditing(false);
    if (body !== ticket.body) act(() => api.updateTicket(slug, ticket.id, { body }));
  };
  const setStatus = (status: Status) => act(() => api.updateTicket(slug, ticket.id, { status }));

  const doCopy = async (label: string, get: () => Promise<string>) => {
    try {
      await copy(await get());
      setCopied(label);
      setTimeout(() => setCopied(null), 1800);
    } catch (e: any) {
      onError(e.message);
    }
  };

  const sendComment = async (thenReady: boolean) => {
    const text = draft.trim();
    if (!text) return;
    await act(async () => {
      await api.addComment(slug, ticket.id, text);
      setDraft("");
      await reloadComments();
      if (thenReady) await api.updateTicket(slug, ticket.id, { status: "ready" });
    });
  };

  const canPlan = ticket.status === "backlog" || ticket.status === "planning";

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={ticket.title}>
        <header className="drawer-head">
          <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="drawer-meta">
          <select value={ticket.status} onChange={(e) => setStatus(e.target.value as Status)} aria-label="Status">
            {COLUMNS.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === "in_progress" && !running}>{c.label}</option>
            ))}
          </select>
          {outcomeBadge(ticket)}
          {ticket.prUrl && <a className="badge pr" href={ticket.prUrl} target="_blank" rel="noreferrer">PR #{ticket.prUrl.split("/").pop()}</a>}
          {ticket.branch && <code className="muted small" title={ticket.worktree ?? ""}>{ticket.branch}</code>}
          <span className="muted small">{ticket.id}</span>
        </div>

        {ticket.error && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {running && ticket.lastActivity && <div className="live-line"><span className="spinner" /> {ticket.lastActivity}</div>}

        <div className="actions">
          {running && <button className="btn danger" onClick={() => act(() => api.stop(slug, ticket.id))}>Stop</button>}
          {!running && ticket.status !== "ready" && ticket.status !== "done" && (
            <button className="btn primary" onClick={() => setStatus("ready")}>{ticket.runCount ? "Send back to Claude" : "Move to Ready"}</button>
          )}
          {canPlan && (
            <button className="btn" onClick={() => doCopy("plan", async () => (await api.planningCommand(slug, ticket.id)).command)}>
              {copied === "plan" ? "Copied!" : "Copy planning command"}
            </button>
          )}
          {ticket.resumeCommand && (
            <button className="btn" disabled={running} title={running ? "Wait for the run to finish" : ticket.resumeCommand}
              onClick={() => doCopy("resume", async () => ticket.resumeCommand!)}>
              {copied === "resume" ? "Copied!" : "Copy resume command"}
            </button>
          )}
          {ticket.prUrl && ticket.status === "review" && (
            <button className="btn ghost" onClick={() => act(() => api.checkPr(slug, ticket.id))}>Check PR now</button>
          )}
          <div className="spacer" />
          {confirmDelete ? (
            <button className="btn danger" onClick={() => act(async () => { await api.deleteTicket(slug, ticket.id); onClose(); })}>Confirm delete</button>
          ) : (
            <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>
        {canPlan && (
          <p className="hint">
            Planning: copy the command, paste in a terminal and chat with Claude. When the plan is agreed Claude updates this
            description. Exit the terminal session, then move the card to Ready.
          </p>
        )}

        <section className="section">
          <div className="section-head">
            <h4>Description</h4>
            {!editing && <button className="btn ghost small" onClick={() => setEditing(true)}>Edit</button>}
          </div>
          {editing ? (
            <>
              <textarea className="body-input" rows={10} value={body} onChange={(e) => setBody(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBody(); }} />
              <div className="form-actions">
                <button className="btn ghost small" onClick={() => { setBody(ticket.body); setEditing(false); }}>Cancel</button>
                <button className="btn primary small" onClick={saveBody}>Save</button>
              </div>
            </>
          ) : body.trim() ? (
            <div className="body-view" onDoubleClick={() => setEditing(true)}><Markdown text={body} /></div>
          ) : (
            <div className="muted">No description.</div>
          )}
        </section>

        <nav className="tabs">
          <button className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>Comments ({comments.length})</button>
          <button className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}>
            Transcript {running && <span className="dot" />}
          </button>
        </nav>

        {tab === "comments" ? (
          <section className="section">
            <div className="comments">
              {comments.map((c) => (
                <div key={c.id} className={`comment ${c.author}`}>
                  <div className="comment-head">
                    <b>{c.author === "ai" ? "Claude" : "You"}</b> <span className="muted small">{timeAgo(c.at)}</span>
                  </div>
                  <Markdown text={c.text} />
                </div>
              ))}
              {!comments.length && <div className="muted">No comments yet.</div>}
            </div>
            <div className="comment-box">
              <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Feedback for Claude…"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendComment(false); }} />
              <div className="form-actions">
                <button className="btn ghost" disabled={!draft.trim()} onClick={() => sendComment(false)}>Comment</button>
                {!running && ticket.status !== "ready" && (
                  <button className="btn primary" disabled={!draft.trim()} onClick={() => sendComment(true)}>Comment &amp; send to Claude</button>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="section">
            <Transcript entries={activity} live={running} />
          </section>
        )}
      </aside>
    </div>
  );
}
