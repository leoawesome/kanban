import { useEffect, useRef, useState } from "react";
import { api, copy, COLUMNS, safeHref, startWorkTarget, subscribe, type ClaudeSession, type Profile, type Status, type Ticket } from "./api";
import { outcomeBadge } from "./Card";
import { BugReportDialog } from "./BugReportDialog";
import { Chat, useStop } from "./Chat";
import { ConfirmDialog } from "./ConfirmDialog";
import { BugIcon, CheckIcon, CloseIcon, CopyIcon, ExternalIcon, FileTextIcon, SparkIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { useFocusTrap, useLayer } from "./layers";
import { ModeToggle } from "./ModeToggle";
import { PlanPanel } from "./PlanPanel";
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
export function TicketDrawer({ profile, ticket, tickets, onOpenTicket, onClose }: {
  profile: Profile;
  ticket: Ticket;
  /** The board's tickets, for the planner/child links. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  onClose: () => void;
}) {
  // Errors from actions in this ticket show here, next to what failed, not in the page's top strip.
  const [panelError, setPanelError] = useState<string | null>(null);
  const onError = (msg: string) => setPanelError(msg);
  const slug = profile.slug;
  const parent = ticket.parentId ? tickets.find((t) => t.id === ticket.parentId) : undefined;
  const children = tickets.filter((t) => t.parentId === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const siblings = ticket.parentId ? tickets.filter((t) => t.parentId === ticket.parentId && t.id !== ticket.id) : [];
  const deps = (ticket.dependsOn ?? []).map((ref) => siblings.find((s) => s.id === ref || s.planKey === ref) ?? ref);
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [editing, setEditing] = useState(false);
  const images = useImagePaste(setBody);
  // Body the current edit started from; the server rejects the save if the file changed meanwhile.
  const [baseBody, setBaseBody] = useState(ticket.body);
  const [tab, setTab] = useState<"chat" | "outputs">("chat");
  const [outputCount, setOutputCount] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [titleSave, setTitleSave] = useState<"saving" | "saved" | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  useLayer(onClose, { skipInInputs: true });
  useFocusTrap(panelRef, true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reportingBug, setReportingBug] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [picking, setPicking] = useState(false);
  const [linked, setLinked] = useState<ClaudeSession | null>(null);
  const [detailsOpen, setDetailsOpenState] = useState(() => {
    try {
      return localStorage.getItem("ckanban.detailsOpen") !== "0";
    } catch {
      return true;
    }
  });
  const setDetailsOpen = (fn: (v: boolean) => boolean) => setDetailsOpenState((v) => {
    const next = fn(v);
    try {
      localStorage.setItem("ckanban.detailsOpen", next ? "1" : "0");
    } catch {}
    return next;
  });
  useEffect(() => {
    // ⌘\ / Ctrl+\ toggles the details column, like a sidebar.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDetailsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const titleRef = useRef<HTMLInputElement>(null);
  const working = ticket.status === "in_progress" || !!ticket.running;
  const att = working ? null : ticket.attention ?? null;
  const { stopping, stop } = useStop(slug, ticket, working, (m) => setPanelError(m));
  const { width, dragging, handle } = usePanelWidth();

  const loadOutputs = () => api.outputs(slug, ticket.id).then((o) => setOutputCount(o.length)).catch(() => {});

  useEffect(() => {
    loadOutputs();
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setBaseBody(t.body); setTitle(t.title); }).catch(() => {});
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
  const saveTitle = async () => {
    if (!title.trim()) return setTitle(ticket.title);
    if (title === ticket.title) return;
    setTitleSave("saving");
    try {
      await api.updateTicket(slug, ticket.id, { title: title.trim() });
      setTitleSave("saved");
      setTimeout(() => setTitleSave((s) => (s === "saved" ? null : s)), 1600);
    } catch (e: any) {
      setTitleSave(null);
      onError(`Title not saved: ${e.message}`);
    }
  };
  const copyText = async (key: string, text: string) => {
    await copy(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
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
    if (images.uploading) return;
    if (body === baseBody) return setEditing(false);
    api.updateTicket(slug, ticket.id, { body, expectedBody: baseBody })
      .then((t) => { setBaseBody(t.body); setEditing(false); })
      .catch((e) => onError(e.message));
  };
  const setStatus = (status: Status) => act(() => api.updateTicket(slug, ticket.id, { status }));
  const col = COLUMNS.find((c) => c.id === ticket.status);
  const startTarget = startWorkTarget(ticket);
  const startWork = () => (startTarget === "planning" ? setStatus("planning") : setConfirmStart(true));

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={panelRef} className={`panel ${dragging ? "resizing" : ""}`} role="dialog" aria-modal="true" aria-label={ticket.title} style={{ width }} tabIndex={-1}>
        <div className="drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...handle} />

        <header className="panel-head">
          <button className={`icon-btn sidebar-toggle ${detailsOpen ? "on" : ""}`} onClick={() => setDetailsOpen((v) => !v)}
            aria-label={detailsOpen ? "Hide details" : "Show details"} aria-pressed={detailsOpen}
            title={`${detailsOpen ? "Hide" : "Show"} details (⌘\\)`}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <rect x="2" y="3" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="7" y1="3.5" x2="7" y2="14.5" stroke="currentColor" strokeWidth="1.5" />
              {detailsOpen && <rect x="2.75" y="3.75" width="3.5" height="10.5" rx="1.5" fill="currentColor" opacity="0.35" />}
            </svg>
          </button>
          <input ref={titleRef} className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") { setTitle(ticket.title); (e.target as HTMLInputElement).blur(); }
            }} aria-label="Title" />
          <span className="save-state" aria-live="polite">
            {titleSave === "saving" && <span className="muted small">Saving…</span>}
            {titleSave === "saved" && <span className="saved small"><CheckIcon size={12} /> Saved</span>}
          </span>
          {att && (
            <span className={`your-turn inline att-${att.kind}`}>
              <span className="yt-dot" aria-hidden /><span className="yt-label">Your turn</span><span className="yt-why">{att.label}</span>
            </span>
          )}
          {!att && outcomeBadge(ticket)}
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><CloseIcon /></button>
        </header>

        <div className={`panel-body ${detailsOpen ? "" : "details-closed"}`}>
          <div className="panel-details">

            <div className="field-row">
              <span className="field-key">Status</span>
              <Select className="status-select" ariaLabel="Status" value={ticket.status} onChange={(s) => setStatus(s as Status)}
                options={COLUMNS.map((c) => ({ value: c.id, label: c.label, hint: c.hint, disabled: c.id === "in_progress" && !working }))} />
            </div>
            {col && <p className="field-help">{col.claude && <SparkIcon className="icon spark" />}{col.hint}</p>}

            <div className="action-stack">
              {working && <button className="btn danger" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop Claude"}</button>}
              {!working && (ticket.status === "backlog" || ticket.status === "planning") && (
                <button className={`btn ${att?.kind === "questions" || att?.kind === "proposal" ? "" : "primary"}`}
                  onClick={startWork} title={startTarget === "planning" ? "Claude interviews you first" : "Claude works on its own"}>Start work</button>
              )}
              {!working && ticket.status === "backlog" && (
                <button className="btn" onClick={() => setStatus("planning")}>Refine with Claude</button>
              )}
              {ticket.status === "review" && <button className="btn primary" onClick={() => setStatus("done")}>Mark done</button>}
              {ticket.prUrl && (
                <a className="btn icon-label" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer">Open PR #{ticket.prUrl.split("/").pop()} <ExternalIcon size={12} /></a>
              )}
            </div>

            <div className="field-row">
              <span className="field-key" title="How Claude works once the ticket is in Ready">When working</span>
              <ModeToggle value={ticket.mode ?? "auto"} disabled={working}
                onChange={(mode) => act(() => api.updateTicket(slug, ticket.id, { mode }))} />
            </div>

            {ticket.parentId && (
              <div className="field-row">
                <span className="field-key" title="The planner ticket whose chat proposed this one">From</span>
                {parent ? (
                  <button className="link-btn ticket-link" onClick={() => onOpenTicket(parent.id)}>{parent.title}</button>
                ) : (
                  <span className="muted small">Planner ticket was deleted</span>
                )}
              </div>
            )}
            {deps.length > 0 && (
              <div className="field-row">
                <span className="field-key" title="A running plan starts this ticket once these are done">Waits for</span>
                <span className="dep-list">
                  {deps.map((d) => typeof d === "string"
                    ? <span key={d} className="muted small">{d} (missing)</span>
                    : <button key={d.id} className="link-btn ticket-link" onClick={() => onOpenTicket(d.id)}>{d.title}</button>)}
                </span>
              </div>
            )}

            {children.length > 0 && (
              <PlanPanel slug={slug} ticket={ticket} children={children} onOpenTicket={onOpenTicket} onError={onError} />
            )}

            <section className="detail-section">
              <div className="section-head">
                <h4>Description</h4>
                {!editing && <button className="btn ghost small" onClick={startEdit}>Edit</button>}
              </div>
              {editing ? (
                <>
                  <textarea className={`body-input${images.dragOver ? " drop-target" : ""}`} rows={12} value={body} onChange={(e) => setBody(e.target.value)} autoFocus
                    placeholder="Markdown. Paste or drop images." {...images.handlers}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBody(); }} />
                  {images.error && <div className="form-error">{images.error}</div>}
                  <div className="form-actions">
                    <button className="btn ghost small" onClick={() => { setBody(baseBody); setEditing(false); images.clearError(); }}>Cancel</button>
                    <button className="btn primary small" disabled={images.uploading} onClick={saveBody}>{images.uploading ? "Uploading…" : "Save"}</button>
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
                  <button className="result-link" onClick={() => setTab("outputs")}><FileTextIcon size={13} /> {outputCount} output file{outputCount > 1 ? "s" : ""}</button>
                )}
                {ticket.session?.artifacts.slice().reverse().map((a) => (
                  <a key={a.url} className="result-link" href={safeHref(a.url)} target="_blank" rel="noreferrer" title={a.url}><ExternalIcon size={13} /> {a.label}</a>
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
                  onClick={() => copyText("resume", ticket.resumeCommand!)}>
                  {copied === "resume" ? "Copied!" : "Copy terminal command"}
                </button>
              )}
              <div className="meta-lines">
                {ticket.branch && (
                  <span className="meta-line">
                    <code title={ticket.worktree ?? ""}>{ticket.branch}</code>
                    <button className="icon-btn tiny" aria-label="Copy branch name" title="Copy branch name" onClick={() => copyText("branch", ticket.branch!)}>
                      {copied === "branch" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                    </button>
                  </span>
                )}
                <span className="meta-line">
                  <span>{ticket.id}</span>
                  <button className="icon-btn tiny" aria-label="Copy ticket ID" title="Copy ticket ID" onClick={() => copyText("id", ticket.id)}>
                    {copied === "id" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                  </button>
                </span>
              </div>
              {ticket.prUrl && ticket.status === "review" && (
                <button className="link-btn" onClick={() => act(() => api.checkPr(slug, ticket.id))}>Check PR status now</button>
              )}
            </section>

            <button className="link-btn small bug-report-btn" onClick={() => setReportingBug(true)}
              title="Something wrong with Claude Kanban on this ticket? File a GitHub issue with its details attached">
              <BugIcon size={12} /> Report a bug in Claude Kanban
            </button>
            <button className="btn ghost danger small delete-btn" onClick={() => setConfirmDelete(true)}>Delete ticket</button>
          </div>

          <div className="panel-main">
            {panelError && (
              <div className="banner error inline panel-error" role="alert">
                <span>{panelError}</span>
                <button className="icon-btn" aria-label="Dismiss" onClick={() => setPanelError(null)}><CloseIcon /></button>
              </div>
            )}
            <nav className="tabs" role="tablist" aria-label="Ticket">
              <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
                Chat {working && <span className="dot" />}
              </button>
              <button role="tab" aria-selected={tab === "outputs"} className={tab === "outputs" ? "active" : ""} onClick={() => setTab("outputs")}>
                Outputs{outputCount > 0 && <span className="tab-count">{outputCount}</span>}
              </button>
            </nav>
            {tab === "outputs" ? (
              <div className="panel-scroll"><Outputs slug={slug} ticketId={ticket.id} onCount={setOutputCount} /></div>
            ) : (
              <Chat slug={slug} ticket={ticket} tickets={tickets} onOpenTicket={onOpenTicket} onError={onError} />
            )}
          </div>
        </div>

        {picking && (
          <SessionPicker slug={slug} folder={profile.path} currentTicketId={ticket.id} onClose={() => setPicking(false)}
            onPick={(s) => act(async () => { await api.linkSession(slug, ticket.id, s.id); setPicking(false); })} />
        )}
        {ticket.error?.startsWith("corrupt") && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {confirmStart && (
          <ConfirmDialog title="Start work?" confirmLabel="Start work" busyLabel="Starting…" tone="primary"
            onCancel={() => setConfirmStart(false)}
            onConfirm={async () => { await api.updateTicket(slug, ticket.id, { status: "ready" }); setConfirmStart(false); }}>
            <p>Claude will work on this on its own. When working: <b>{ticket.mode === "interview" ? "Interview me first" : "Just do it"}</b>.</p>
          </ConfirmDialog>
        )}
        {reportingBug && (
          <BugReportDialog ticket={{ profile: slug, id: ticket.id, title: ticket.title }} onClose={() => setReportingBug(false)} />
        )}
        {confirmDelete && (
          <ConfirmDialog title={`Delete "${ticket.title}"?`} confirmLabel="Delete ticket" busyLabel="Deleting…" onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onClose(); }}>
            <p>Removes the ticket and its board history.{working ? " Claude will be stopped." : ""}</p>
            {ticket.worktree && <p className="muted">Its worktree is removed if it has no uncommitted changes. The branch and any PR stay.</p>}
          </ConfirmDialog>
        )}
      </aside>
    </div>
  );
}
