import { useEffect, useRef, useState } from "react";
import { api, copy, COLUMNS, safeHref, subscribe, type ClaudeSession, type Profile, type Status, type Ticket } from "./api";
import { outcomeBadge } from "./Card";
import { Chat } from "./Chat";
import { ConfirmDialog } from "./ConfirmDialog";
import { ModeToggle } from "./ModeToggle";
import { Outputs } from "./Outputs";
import { Select } from "./Select";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { Markdown } from "./Transcript";

const WIDTH_KEY = "ckanban.panelWidth";
const MIN_WIDTH = 640;

const defaultWidth = () => Math.round(window.innerWidth * 0.8);

function clampWidth(w: number): number {
  return Math.round(Math.min(Math.max(w, Math.min(MIN_WIDTH, window.innerWidth)), window.innerWidth));
}

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v) return clampWidth(v);
  } catch {}
  return clampWidth(defaultWidth());
}

/** Drag the panel's left edge to resize; double-click resets to 80%. Width persists per browser. */
function usePanelWidth() {
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
    const w = clampWidth(defaultWidth());
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

/** Ticket view: details on the left, the chat with Claude filling the right side. */
export function TicketDrawer({ profile, ticket, onClose, onError }: {
  profile: Profile;
  ticket: Ticket;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const slug = profile.slug;
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [editing, setEditing] = useState(false);
  // Body the current edit started from; the server rejects the save if the file changed meanwhile.
  const [baseBody, setBaseBody] = useState(ticket.body);
  const [tab, setTab] = useState<"chat" | "outputs">("chat");
  const [outputCount, setOutputCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picking, setPicking] = useState(false);
  const [linked, setLinked] = useState<ClaudeSession | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const titleRef = useRef<HTMLInputElement>(null);
  const working = ticket.status === "in_progress" || !!ticket.running;
  const att = working ? null : ticket.attention ?? null;
  const { width, dragging, handle } = usePanelWidth();

  const loadOutputs = () => api.outputs(slug, ticket.id).then((o) => setOutputCount(o.length)).catch(() => {});

  useEffect(() => {
    loadOutputs();
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setBaseBody(t.body); setTitle(t.title); }).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input, textarea")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, ticket.id]);

  useEffect(() => {
    if (!ticket.workdir || !ticket.sessionId) return setLinked(null);
    api.sessions(slug).then((ss) => setLinked(ss.find((s) => s.id === ticket.sessionId) ?? null)).catch(() => {});
  }, [slug, ticket.sessionId, ticket.workdir, ticket.status]);

  useEffect(() => subscribe((e) => {
    if (e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticket.id) loadOutputs();
  }), [slug, ticket.id]);

  useEffect(() => {
    if (!editing) {
      setBody(ticket.body);
      setBaseBody(ticket.body);
    }
  }, [ticket.body]);
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(ticket.title);
  }, [ticket.title]);

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
  const startEdit = async () => {
    try {
      const fresh = await api.ticket(slug, ticket.id);
      setBody(fresh.body);
      setBaseBody(fresh.body);
    } catch {}
    setEditing(true);
  };
  const saveBody = () => {
    if (body === baseBody) return setEditing(false);
    api.updateTicket(slug, ticket.id, { body, expectedBody: baseBody })
      .then((t) => { setBaseBody(t.body); setEditing(false); })
      .catch((e) => onError(e.message));
  };
  const setStatus = (status: Status) => act(() => api.updateTicket(slug, ticket.id, { status }));
  const col = COLUMNS.find((c) => c.id === ticket.status);

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`panel ${dragging ? "resizing" : ""}`} role="dialog" aria-label={ticket.title} style={{ width }}>
        <div className="drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...handle} />

        <header className="panel-head">
          <input ref={titleRef} className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} aria-label="Title" />
          {att && (
            <span className={`your-turn inline att-${att.kind}`}>
              <span className="yt-dot" aria-hidden /><span className="yt-label">Your turn</span><span className="yt-why">{att.label}</span>
            </span>
          )}
          {!att && outcomeBadge(ticket)}
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={`panel-body ${detailsOpen ? "" : "details-closed"}`}>
          <div className="panel-details">
            <button className="details-toggle link-btn" onClick={() => setDetailsOpen((v) => !v)}>
              {detailsOpen ? "Hide details" : "Show details"}
            </button>

            <div className="field-row">
              <span className="field-key">Status</span>
              <Select className="status-select" ariaLabel="Status" value={ticket.status} onChange={(s) => setStatus(s as Status)}
                options={COLUMNS.map((c) => ({ value: c.id, label: c.label, hint: c.hint, disabled: c.id === "in_progress" && !working }))} />
            </div>
            {col && <p className="field-help">{col.claude ? "✦ " : ""}{col.hint}</p>}

            <div className="action-stack">
              {working && <button className="btn danger" onClick={() => act(() => api.stop(slug, ticket.id))}>Stop Claude</button>}
              {!working && (ticket.status === "backlog" || ticket.status === "planning") && (
                <button className={`btn ${att?.kind === "questions" || att?.kind === "proposal" ? "" : "primary"}`}
                  onClick={() => setStatus("ready")} title="Claude works on the ticket on its own">Start work</button>
              )}
              {!working && ticket.status === "backlog" && (
                <button className="btn" onClick={() => setStatus("planning")}>Refine with Claude</button>
              )}
              {ticket.status === "review" && <button className="btn primary" onClick={() => setStatus("done")}>Mark done</button>}
              {ticket.prUrl && (
                <a className="btn" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer">Open PR #{ticket.prUrl.split("/").pop()} ↗</a>
              )}
            </div>

            <div className="field-row">
              <span className="field-key" title="How Claude works once the ticket is in Ready">When working</span>
              <ModeToggle value={ticket.mode ?? "auto"} disabled={working}
                onChange={(mode) => act(() => api.updateTicket(slug, ticket.id, { mode }))} />
            </div>

            <section className="detail-section">
              <div className="section-head">
                <h4>Description</h4>
                {!editing && <button className="btn ghost small" onClick={startEdit}>Edit</button>}
              </div>
              {editing ? (
                <>
                  <textarea className="body-input" rows={12} value={body} onChange={(e) => setBody(e.target.value)} autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBody(); }} />
                  <div className="form-actions">
                    <button className="btn ghost small" onClick={() => { setBody(baseBody); setEditing(false); }}>Cancel</button>
                    <button className="btn primary small" onClick={saveBody}>Save</button>
                  </div>
                </>
              ) : body.trim() ? (
                <div className="body-view" onDoubleClick={startEdit}><Markdown text={body} /></div>
              ) : (
                <div className="muted small">No description yet. {ticket.status === "planning" ? "Claude can propose one in the chat." : ""}</div>
              )}
            </section>

            {(!!ticket.session?.artifacts.length || outputCount > 0) && (
              <section className="detail-section">
                <h4>Results</h4>
                {outputCount > 0 && (
                  <button className="result-link" onClick={() => setTab("outputs")}>📄 {outputCount} output file{outputCount > 1 ? "s" : ""}</button>
                )}
                {ticket.session?.artifacts.slice().reverse().map((a) => (
                  <a key={a.url} className="result-link" href={safeHref(a.url)} target="_blank" rel="noreferrer" title={a.url}>↗ {a.label}</a>
                ))}
              </section>
            )}

            <section className="detail-section">
              <h4>Session</h4>
              {ticket.workdir && ticket.sessionId ? (
                <div className="session-line">
                  <span>Linked: <b>{linked ? sessionLabel(linked) : ticket.sessionId.slice(0, 8)}</b></span>
                  {(ticket.terminalOpen || linked?.live) && <span className="badge running"><span className="live-dot" /> open in terminal</span>}
                  {!working && <button className="link-btn" onClick={() => setPicking(true)}>Change</button>}
                  {!working && <button className="link-btn" onClick={() => act(() => api.linkSession(slug, ticket.id, null))}>Unlink</button>}
                </div>
              ) : !working && ticket.status !== "done" && ticket.runCount === 0 && (
                <button className="link-btn" onClick={() => setPicking(true)}>Link an existing Claude session…</button>
              )}
              {ticket.resumeCommand && (
                <button className="btn small" disabled={working} title={working ? "Wait until Claude is done" : ticket.resumeCommand}
                  onClick={async () => { await copy(ticket.resumeCommand!); setCopied(true); setTimeout(() => setCopied(false), 1600); }}>
                  {copied ? "Copied!" : "Copy terminal command"}
                </button>
              )}
              <div className="meta-lines">
                {ticket.branch && <code title={ticket.worktree ?? ""}>{ticket.branch}</code>}
                <span>{ticket.id}</span>
              </div>
              {ticket.prUrl && ticket.status === "review" && (
                <button className="link-btn" onClick={() => act(() => api.checkPr(slug, ticket.id))}>Check PR status now</button>
              )}
            </section>

            <button className="btn ghost danger-text small delete-btn" onClick={() => setConfirmDelete(true)}>Delete ticket</button>
          </div>

          <div className="panel-main">
            {outputCount > 0 && (
              <nav className="tabs">
                <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>Chat {working && <span className="dot" />}</button>
                <button className={tab === "outputs" ? "active" : ""} onClick={() => setTab("outputs")}>Outputs ({outputCount})</button>
              </nav>
            )}
            {tab === "outputs" && outputCount > 0 ? (
              <div className="panel-scroll"><Outputs slug={slug} ticketId={ticket.id} onCount={setOutputCount} /></div>
            ) : (
              <Chat slug={slug} ticket={ticket} onError={onError} />
            )}
          </div>
        </div>

        {picking && (
          <SessionPicker slug={slug} folder={profile.path} currentTicketId={ticket.id} onClose={() => setPicking(false)}
            onPick={(s) => act(async () => { await api.linkSession(slug, ticket.id, s.id); setPicking(false); })} />
        )}
        {ticket.error?.startsWith("corrupt") && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {confirmDelete && (
          <ConfirmDialog title={`Delete "${ticket.title}"?`} confirmLabel="Delete ticket" onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onClose(); }}>
            <p>Removes the ticket and its board history.{working ? " Claude will be stopped." : ""}</p>
            {ticket.worktree && <p className="muted">Its worktree is removed if it has no uncommitted changes. The branch and any PR stay.</p>}
          </ConfirmDialog>
        )}
      </aside>
    </div>
  );
}
