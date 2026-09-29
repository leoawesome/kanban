import { useEffect, useRef, useState } from "react";
import { api, copy, COLUMNS, safeHref, subscribe, type ActivityEntry, type ClaudeSession, type Comment, type Profile, type Status, type Ticket } from "./api";
import { outcomeBadge } from "./Card";
import { ConfirmDialog } from "./ConfirmDialog";
import { Conversation } from "./Conversation";
import { Select } from "./Select";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { timeAgo } from "./time";
import { Markdown, Transcript } from "./Transcript";

const WIDTH_KEY = "ckanban.drawerWidth";
const DEFAULT_WIDTH = 760;
const MIN_WIDTH = 420;

function clampWidth(w: number): number {
  return Math.round(Math.min(Math.max(w, MIN_WIDTH), window.innerWidth - 40));
}

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v) return clampWidth(v);
  } catch {}
  return clampWidth(DEFAULT_WIDTH);
}

/** Drag the drawer's left edge to resize; double-click resets. Width persists per browser. */
function useDrawerWidth() {
  const [width, setWidth] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {}
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) setWidth(clampWidth(window.innerWidth - e.clientX));
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => {
    const w = clampWidth(DEFAULT_WIDTH);
    setWidth(w);
    persist(w);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const w = clampWidth(widthRef.current + (e.key === "ArrowLeft" ? step : -step));
      setWidth(w);
      persist(w);
    }
  };

  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
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
  // Body the current edit started from; the server rejects the save if the file changed since
  // (Claude rewrites ticket.md during terminal planning without the board being notified).
  const [baseBody, setBaseBody] = useState(ticket.body);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"comments" | "conversation" | "transcript">(
    ticket.status === "in_progress" ? "transcript" : ticket.workdir && ticket.sessionId ? "conversation" : "comments");
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picking, setPicking] = useState(false);
  const [linked, setLinked] = useState<ClaudeSession | null>(null);
  const running = ticket.status === "in_progress";
  const { width, dragging, handle } = useDrawerWidth();

  const reloadComments = () => api.comments(slug, ticket.id).then(setComments).catch(() => {});

  useEffect(() => {
    reloadComments();
    api.activity(slug, ticket.id).then(setActivity).catch(() => {});
    // Claude may rewrite the body during planning; fetch fresh copy on open.
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setBaseBody(t.body); setTitle(t.title); }).catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, ticket.id]);

  useEffect(() => {
    if (!ticket.workdir || !ticket.sessionId) {
      setLinked(null);
      return;
    }
    api.sessions(slug).then((ss) => setLinked(ss.find((s) => s.id === ticket.sessionId) ?? null)).catch(() => {});
  }, [slug, ticket.sessionId, ticket.workdir, ticket.status]);

  useEffect(() => subscribe((e) => {
    if (e.type === "activity" && e.profile === slug && e.id === ticket.id) {
      setActivity((a) => [...a, { run: e.run, at: new Date().toISOString(), event: e.event }]);
    }
    if (e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticket.id) reloadComments();
  }), [slug, ticket.id]);

  useEffect(() => {
    if (!editing) {
      setBody(ticket.body);
      setBaseBody(ticket.body);
    }
  }, [ticket.body]);

  const startEdit = async () => {
    try {
      const fresh = await api.ticket(slug, ticket.id);
      setBody(fresh.body);
      setBaseBody(fresh.body);
    } catch {}
    setEditing(true);
  };

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
    if (body === baseBody) {
      setEditing(false);
      return;
    }
    api.updateTicket(slug, ticket.id, { body, expectedBody: baseBody })
      .then((t) => {
        setBaseBody(t.body);
        setEditing(false);
      })
      .catch((e) => onError(e.message));
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

  const canPlan = (ticket.status === "backlog" || ticket.status === "planning") && !ticket.workdir;

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`drawer ${dragging ? "resizing" : ""}`} role="dialog" aria-label={ticket.title} style={{ width }}>
        <div className="drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...handle} />
        <header className="drawer-head">
          <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="drawer-meta">
          <Select
            className="status-select"
            ariaLabel="Status"
            value={ticket.status}
            onChange={(s) => setStatus(s as Status)}
            options={COLUMNS.map((c) => ({ value: c.id, label: c.label, disabled: c.id === "in_progress" && !running }))}
          />
          {outcomeBadge(ticket)}
          {ticket.prUrl && <a className="badge pr" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer">PR #{ticket.prUrl.split("/").pop()}</a>}
          {ticket.branch && <code className="muted small" title={ticket.worktree ?? ""}>{ticket.branch}</code>}
          <span className="muted small">{ticket.id}</span>
        </div>

        {ticket.error && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {running && ticket.lastActivity && <div className="live-line"><span className="spinner" /> {ticket.lastActivity}</div>}

        <div className="actions">
          {running && <button className="btn danger" onClick={() => act(() => api.stop(slug, ticket.id))}>Stop</button>}
          {!running && ticket.status !== "ready" && ticket.status !== "done" && (
            <button className="btn primary" onClick={() => setStatus("ready")}>
              {ticket.runCount || ticket.workdir ? "Send to Claude" : "Move to Ready"}
            </button>
          )}
          {ticket.status === "review" && <button className="btn" onClick={() => setStatus("done")}>Mark done</button>}
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
          <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
        {ticket.workdir && ticket.sessionId ? (
          <div className="session-box">
            <div className="session-chip">
              <span className="muted small">Linked session</span>
              <span className="session-title" title={ticket.sessionId}>{linked ? sessionLabel(linked) : ticket.sessionId.slice(0, 8)}</span>
              {linked?.live && <span className="badge running"><span className="live-dot" /> open in terminal</span>}
              {!running && <button className="link-btn" onClick={() => setPicking(true)}>Change</button>}
              {!running && <button className="link-btn" onClick={() => act(() => api.linkSession(slug, ticket.id, null))}>Unlink</button>}
            </div>
            {linked?.live && ticket.status !== "in_progress" && (
              <span className="muted small">Exit the terminal session before sending this ticket to Claude.</span>
            )}
          </div>
        ) : !running && ticket.status !== "done" && ticket.runCount === 0 && (
          <div className="session-box">
            <button className="link-btn" onClick={() => setPicking(true)}>Link an existing Claude session…</button>
          </div>
        )}
        {picking && (
          <SessionPicker slug={slug} folder={profile.path} currentTicketId={ticket.id} onClose={() => setPicking(false)}
            onPick={(s) => act(async () => { await api.linkSession(slug, ticket.id, s.id); setPicking(false); })} />
        )}
        {canPlan && !ticket.workdir && (
          <p className="hint">
            Planning: copy the command, paste in a terminal and chat with Claude. When the plan is agreed Claude updates this
            description. Exit the terminal session, then move the card to Ready.
          </p>
        )}

        <section className="section">
          <div className="section-head">
            <h4>Description</h4>
            {!editing && <button className="btn ghost small" onClick={startEdit}>Edit</button>}
          </div>
          {editing ? (
            <>
              <textarea className="body-input" rows={10} value={body} onChange={(e) => setBody(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBody(); }} />
              <div className="form-actions">
                <button className="btn ghost small" onClick={() => { setBody(baseBody); setEditing(false); }}>Cancel</button>
                <button className="btn primary small" onClick={saveBody}>Save</button>
              </div>
            </>
          ) : body.trim() ? (
            <div className="body-view" onDoubleClick={startEdit}><Markdown text={body} /></div>
          ) : (
            <div className="muted">No description.</div>
          )}
        </section>

        {!!ticket.session?.artifacts.length && (
          <div className="artifacts">
            <span className="muted small">Artifacts</span>
            {ticket.session.artifacts.slice().reverse().map((a) => (
              <a key={a.url} className="artifact-chip" href={safeHref(a.url)} target="_blank" rel="noreferrer" title={a.url}>
                {a.label} <span aria-hidden>↗</span>
              </a>
            ))}
          </div>
        )}

        <nav className="tabs">
          <button className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>Comments ({comments.length})</button>
          {ticket.sessionId && (
            <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>Conversation</button>
          )}
          {(ticket.runCount > 0 || running || activity.length > 0) && (
            <button className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}>
              Run log {running && <span className="dot" />}
            </button>
          )}
        </nav>

        {tab === "conversation" && ticket.sessionId ? (
          <section className="section">
            <Conversation slug={slug} ticketId={ticket.id} resumeCommand={ticket.resumeCommand} />
          </section>
        ) : tab === "comments" ? (
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
        {confirmDelete && (
          <ConfirmDialog
            title={`Delete "${ticket.title}"?`}
            confirmLabel="Delete ticket"
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onClose(); }}
          >
            <p>Removes the ticket, its comments and transcript.{running ? " The running Claude session will be stopped." : ""}</p>
            {ticket.worktree && <p className="muted">Its worktree is removed if it has no uncommitted changes. The branch and any PR stay.</p>}
          </ConfirmDialog>
        )}
      </aside>
    </div>
  );
}
