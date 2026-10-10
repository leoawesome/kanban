import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type Huddle, type HuddleMessage, type HuddleMode, type HuddleParticipant, type Ticket } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { draftKey } from "./drafts";
import {
  handleColor, handleInitials, huddleCost, members, mentionCandidates, mentionQuery, participantActivity, type HuddleState,
} from "./huddle";
import { DEFAULT_MAX, draftError, RosterEditor, rosterDraft, startFromDraft, usePresets, type RosterDraft } from "./HuddleRoster";
import { CloseIcon } from "./icons";
import { KeyHint } from "./KeyHint";
import { Select } from "./Select";
import { fullTime } from "./time";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";

const clock = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const money = (n: number) => `$${n.toFixed(2)}`;
const STATE_LABEL = { live: "● Live", stopped: "■ Stopped", closed: "Closed" } as const;

function Avatar({ handle, small }: { handle: string; small?: boolean }) {
  return <span className={`hd-av${small ? " small" : ""}`} style={{ background: handleColor(handle) }} aria-hidden>{handleInitials(handle)}</span>;
}

/** The Huddle tab: the ticket's huddle (feed, roster, findings, composer), or a roster editor to start one. */
export function HuddlePanel({ slug, ticket, tickets, state, onError }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  state: HuddleState;
  onError: (m: string) => void;
}) {
  // Starting a new huddle after the last one closed (its history stays a click away).
  const [fresh, setFresh] = useState(false);
  const h = state.huddle;
  useEffect(() => setFresh(false), [h?.id]);
  if (!state.loaded) return <div className="panel-scroll muted"><span className="spinner" /> Loading the huddle…</div>;
  if (state.error && !h) {
    return (
      <div className="panel-scroll">
        <div className="banner error inline" role="alert">Couldn't load the huddle: {state.error} <button className="link-btn" onClick={() => state.reload()}>Retry</button></div>
      </div>
    );
  }
  if (!h || fresh) {
    return <StartHuddle slug={slug} ticket={ticket} tickets={tickets} onError={onError} onBack={h ? () => setFresh(false) : undefined}
      onStarted={() => state.reload()} />;
  }
  return <HuddleRoom slug={slug} ticket={ticket} tickets={tickets} huddle={h} state={state} onError={onError} onNew={() => setFresh(true)} />;
}

/** No huddle yet: pick a roster and start one by hand. */
function StartHuddle({ slug, ticket, tickets, onError, onBack, onStarted }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  onError: (m: string) => void;
  onBack?: () => void;
  onStarted: () => void;
}) {
  const presets = usePresets(slug);
  const [draft, setDraft] = useState<RosterDraft>(() => rosterDraft([{ preset: "reviewer" }, { preset: "qa" }]));
  const [busy, setBusy] = useState(false);
  const err = draftError(draft);
  // Built-ins renamed or removed on this board: drop rows whose preset doesn't exist.
  useEffect(() => {
    if (!presets?.length) return;
    const names = new Set(presets.map((p) => p.name));
    setDraft((d) => ({ ...d, rows: d.rows.filter((r) => !r.preset || names.has(r.preset)) }));
  }, [presets]);
  const start = async () => {
    if (busy || err) return;
    setBusy(true);
    try {
      await startFromDraft(slug, ticket.id, draft);
      onStarted();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-scroll panel-huddle-start">
      <div className="huddle-intro">
        <h3>Start a huddle</h3>
        <p className="muted">
          Helper Claude sessions (reviewers, QA, a lead…) work on this ticket with its own session, which joins as <b>@main</b> and coordinates.
          They talk in one room; you can read along and @tag anyone. Claude can also propose a roster from the chat.
        </p>
      </div>
      <div className="huddle-card">
        <div className="huddle-card-head"><span>🗣 New huddle</span><small>roster</small></div>
        <RosterEditor presets={presets} draft={draft} setDraft={setDraft} tickets={tickets} hostId={ticket.id} onEnter={start} disabled={busy} />
        <div className="huddle-card-actions">
          <span className="muted small">{err ?? "Agents start as soon as you press Start."}</span>
          <span className="spacer" />
          {onBack && <button className="btn small" onClick={onBack}>Back to the last huddle</button>}
          <button className="btn primary small" onClick={start} disabled={busy || !!err || presets === null}>{busy ? "Starting…" : "Start huddle"}</button>
        </div>
      </div>
    </div>
  );
}

function HuddleRoom({ slug, ticket, tickets, huddle: h, state, onError, onNew }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  huddle: Huddle;
  state: HuddleState;
  onError: (m: string) => void;
  onNew: () => void;
}) {
  const [confirm, setConfirm] = useState<"stop" | "close" | null>(null);
  const [adding, setAdding] = useState(false);
  const closed = h.status === "closed";
  const run = (p: Promise<unknown>) => p.catch((e) => onError((e as Error).message));
  const count = members(h).length;
  const invitable = tickets.filter((t) => !h.participants.some((p) => p.ticketId === t.id));
  const handles = h.participants.map((p) => p.handle).concat("all");

  return (
    <div className="huddle">
      <div className="huddle-bar">
        <span className={`huddle-state ${h.status}`}>{STATE_LABEL[h.status]}</span>
        <span title={fullTime(h.createdAt)}>started {clock(h.createdAt)}</span>
        <span>· {h.seq} message{h.seq === 1 ? "" : "s"}</span>
        <span title="What the huddle's agents spent so far (@main's runs count toward the ticket's usage)">· {money(huddleCost(h))}</span>
        <span className="spacer" />
        {closed ? (
          <>
            {h.closedAt && <span title={fullTime(h.closedAt)}>closed {clock(h.closedAt)} · read-only</span>}
            <button className="btn small" onClick={onNew}>New huddle</button>
          </>
        ) : (
          <>
            <button className="btn small" onClick={() => setAdding((a) => !a)} disabled={count >= h.maxParticipants}
              title={count >= h.maxParticipants ? `The huddle is full (${h.maxParticipants})` : undefined}>+ Add agent</button>
            {invitable.length > 0 && count < h.maxParticipants && (
              <Select ariaLabel="Invite a ticket" className="roster-add bar" value={"" as string} renderValue={() => "+ Invite ticket"} menuMaxHeight={260}
                options={invitable.map((t) => ({ value: t.id, label: t.title, hint: t.id }))}
                onChange={(id) => run(api.inviteToHuddle(slug, h.id, id))} />
            )}
            {h.status === "stopped" ? (
              <button className="btn small" onClick={() => run(api.huddleAction(slug, h.id, "resume"))}>▶ Resume</button>
            ) : (
              <button className="btn small hd-danger" onClick={() => setConfirm("stop")}>■ Stop all</button>
            )}
            <button className="btn small" onClick={() => setConfirm("close")}>Close huddle</button>
          </>
        )}
      </div>
      {adding && !closed && <AddAgent slug={slug} huddle={h} onDone={() => setAdding(false)} onError={onError} />}
      <div className="huddle-body">
        <div className="huddle-feed">
          <Feed huddle={h} state={state} handles={handles} />
          <Composer slug={slug} ticket={ticket} huddle={h} onError={onError} />
        </div>
        <aside className="huddle-side">
          <Roster slug={slug} huddle={h} onError={onError} />
          <Findings slug={slug} huddle={h} handles={handles} onError={onError} />
        </aside>
      </div>
      {confirm === "stop" && (
        <ConfirmDialog title="Stop all?" confirmLabel="Stop all" busyLabel="Stopping…" onCancel={() => setConfirm(null)}
          onConfirm={async () => { await api.huddleAction(slug, h.id, "stop"); setConfirm(null); }}>
          <p>Every participant's run stops now, @main's included. Nobody wakes until you resume the huddle.</p>
        </ConfirmDialog>
      )}
      {confirm === "close" && (
        <ConfirmDialog title="Close the huddle?" confirmLabel="Close huddle" busyLabel="Closing…" onCancel={() => setConfirm(null)}
          onConfirm={async () => { await api.huddleAction(slug, h.id, "close"); setConfirm(null); }}>
          <p>Every run stops and the huddle becomes read-only. Its history stays here.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The message feed: system lines, messages with @mention chips, finding highlights. Sticks to the bottom while you're there. */
function Feed({ huddle: h, state, handles }: { huddle: Huddle; state: HuddleState; handles: string[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const keep = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const byHandle = new Map(h.participants.map((p) => [p.handle, p]));
  const last = state.messages.at(-1)?.seq;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [last, state.messages.length]);

  const earlier = async () => {
    const el = scroller.current;
    setLoading(true);
    keep.current = el ? el.scrollHeight - el.scrollTop : null;
    try {
      await state.loadEarlier();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="huddle-log" ref={scroller} aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}>
      {state.hasMore && <button className="btn ghost small load-earlier" onClick={earlier} disabled={loading}>{loading ? "Loading…" : "Load earlier"}</button>}
      {!state.messages.length && <div className="hd-sys">No messages yet.</div>}
      {state.messages.map((m) => <Message key={m.seq} m={m} p={byHandle.get(m.from)} handles={handles} />)}
    </div>
  );
}

function Message({ m, p, handles }: { m: HuddleMessage; p: HuddleParticipant | undefined; handles: string[] }) {
  if (m.kind === "system") return <div className="hd-sys" title={fullTime(m.ts)}><MentionText text={m.text} handles={handles} /></div>;
  const mine = m.from === "you";
  return (
    <div className={`hd-msg${mine ? " mine" : ""}`}>
      <Avatar handle={m.from} />
      <div className="hd-msg-body">
        <div className="hd-msg-head">
          <b>@{m.from}</b>
          {p && p.kind !== "human" && <span className="muted">{p.role}</span>}
          <time className="muted" dateTime={m.ts} title={fullTime(m.ts)}>· {clock(m.ts)}</time>
          {p?.mode === "monitor" && p.kind !== "human" && <span className="hd-mode monitor">monitor</span>}
        </div>
        {m.kind === "finding" ? (
          <div className="hd-finding"><span className="hd-finding-tag">⚠ Finding</span><Markdown text={m.text} handles={handles} /></div>
        ) : (
          <Markdown text={m.text} handles={handles} />
        )}
      </div>
    </div>
  );
}

/** Plain text with @mention chips (system lines). */
function MentionText({ text, handles }: { text: string; handles: string[] }) {
  const known = new Set(handles);
  const parts = text.split(/(@[a-z0-9][a-z0-9_-]*)/gi);
  return <>{parts.map((s, i) => (i % 2 && known.has(s.slice(1).toLowerCase()) ? <span key={i} className="at-chip">{s}</span> : <Fragment key={i}>{s}</Fragment>))}</>;
}

/** The user's message box, with @ autocomplete (@main, @all, handles). */
function Composer({ slug, ticket, huddle: h, onError }: { slug: string; ticket: Ticket; huddle: Huddle; onError: (m: string) => void }) {
  const [draft, setDraft] = usePersistentState(draftKey(slug, `${ticket.id}.huddle`), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedPopup, setClosedPopup] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const closed = h.status === "closed";
  const q = mentionQuery(draft, caret);
  const options = q ? mentionCandidates(h).filter((c) => c.handle.startsWith(q.query)) : [];
  const open = !!q && options.length > 0 && !closedPopup;
  useEffect(() => setActive(0), [q?.query, q?.start]);

  const pick = (handle: string) => {
    if (!q) return;
    const next = `${draft.slice(0, q.start)}@${handle} ${draft.slice(caret)}`;
    const at = q.start + handle.length + 2;
    setDraft(next);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || sending || closed) return;
    setSending(true);
    try {
      await api.postHuddle(slug, h.id, text);
      setDraft("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[Math.min(active, options.length - 1)].handle);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setClosedPopup(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  if (closed) return <div className="huddle-closed muted small">This huddle is closed: the history stays, read-only.</div>;
  return (
    <div className="composer huddle-composer">
      {open && (
        <div className="hd-pop" role="listbox" aria-label="Mention">
          {options.map((o, i) => (
            <div key={o.handle} role="option" aria-selected={i === active} className={i === active ? "on" : undefined}
              onMouseDown={(e) => { e.preventDefault(); pick(o.handle); }} onMouseEnter={() => setActive(i)}>
              <b>@{o.handle}</b> <span className="muted">· {o.label}</span>
            </div>
          ))}
        </div>
      )}
      <textarea ref={ref} rows={2} value={draft} disabled={sending}
        placeholder={h.status === "stopped" ? "The huddle is stopped: nobody wakes until you resume it…" : "Message the huddle: @main, @all or @handle to wake someone…"}
        onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setClosedPopup(false); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setClosedPopup(true)} onFocus={() => setClosedPopup(false)}
        onKeyDown={onKeyDown} aria-label="Message the huddle" />
      <div className="composer-foot">
        <span className="muted small composer-hint">
          You post as <b>@you</b>. Tagged participants wake; monitors read everything.
          <span className="composer-keys"> Enter to send · Shift+Enter for a new line</span>
        </span>
        <span className="composer-actions">
          <button className="btn primary small" disabled={!draft.trim() || sending} onClick={send}>{sending ? "Sending…" : "Send"}<KeyHint keys="↵" /></button>
        </span>
      </div>
    </div>
  );
}

/** Participants: mode (click to switch), status and what each is doing; the cap counter. */
function Roster({ slug, huddle: h, onError }: { slug: string; huddle: Huddle; onError: (m: string) => void }) {
  const closed = h.status === "closed";
  const ps = [...h.participants.filter((p) => p.kind !== "human"), ...h.participants.filter((p) => p.kind === "human")];
  const setMode = (p: HuddleParticipant, mode: HuddleMode) => api.setHuddleMode(slug, h.id, p.handle, mode).catch((e) => onError(e.message));
  return (
    <section>
      <h3>Participants <span className="hd-cap">{members(h).length}/{h.maxParticipants}</span></h3>
      {ps.map((p) => {
        const human = p.kind === "human";
        const st = p.status === "working" ? "working" : p.status === "failed" ? "failed" : p.status === "stopped" ? "stopped" : "idle";
        return (
          <div key={p.handle} className="hd-p">
            <Avatar handle={p.handle} small />
            <div className="hd-p-main">
              <div className="hd-p-name">
                <b>@{p.handle}</b>
                {p.handle === "main" && <span className="pill lead">coordinator</span>}
                {p.lead && p.handle !== "main" && !human && <span className="pill lead">lead</span>}
              </div>
              <div className={`hd-p-st ${st}`} title={p.error ?? p.lastActivity ?? undefined}>
                {!human && <span className={`hd-dot ${st}`} />}
                {human ? "human" : participantActivity(p, closed)}
              </div>
            </div>
            {!human && (
              <span className="hd-p-actions">
                <button className={`hd-mode ${p.mode}`} disabled={closed} title={closed ? undefined : `Switch to ${p.mode === "monitor" ? "tagged" : "monitor"} mode`}
                  onClick={() => setMode(p, p.mode === "monitor" ? "tagged" : "monitor")}>{p.mode}</button>
                {!closed && p.status !== "stopped" && (
                  <button className="icon-btn tiny hd-p-stop" aria-label={`Stop @${p.handle}`} title={`Stop @${p.handle}`}
                    onClick={() => api.stopHuddleParticipant(slug, h.id, p.handle).catch((e) => onError(e.message))}><CloseIcon size={10} /></button>
                )}
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** The pinned findings checklist; the user can pin and resolve too. */
function Findings({ slug, huddle: h, handles, onError }: { slug: string; huddle: Huddle; handles: string[]; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const closed = h.status === "closed";
  const by = [...new Set(h.findings.map((f) => f.by))];
  const open = h.findings.filter((f) => f.status === "open").length;
  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.huddleFindings(slug, h.id, "add", { text: text.trim() });
      setText("");
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <section>
      <h3>Findings{h.findings.length > 0 && <span className="hd-cap">{open} open</span>}</h3>
      {by.length > 0 && <div className="hd-pinned muted small">pinned by {by.map((b) => `@${b}`).join(", ")}</div>}
      {!h.findings.length && <div className="muted small">Nothing pinned yet. Leads and @main pin what needs fixing here.</div>}
      {h.findings.map((f) => (
        <label key={f.id} className={`hd-chk${f.status === "resolved" ? " done" : ""}`} title={f.resolvedBy ? `resolved by @${f.resolvedBy}` : `pinned by @${f.by}`}>
          <input type="checkbox" checked={f.status === "resolved"} disabled={closed || f.status === "resolved"}
            onChange={() => api.huddleFindings(slug, h.id, "resolve", { id: f.id }).catch((e) => onError(e.message))} />
          <span><MentionText text={f.text} handles={handles} /></span>
        </label>
      ))}
      {!closed && (
        <input className="hd-add-finding" value={text} placeholder="Pin a finding…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
      )}
    </section>
  );
}

/** + Add agent: one roster line added to the live huddle. */
function AddAgent({ slug, huddle: h, onDone, onError }: { slug: string; huddle: Huddle; onDone: () => void; onError: (m: string) => void }) {
  const presets = usePresets(slug);
  const [draft, setDraft] = useState<RosterDraft>(() => rosterDraft([{ preset: "qa" }]));
  const [busy, setBusy] = useState(false);
  const room = h.maxParticipants - members(h).length;
  const size = draft.rows.reduce((n, r) => n + (r.count ?? 1), 0);
  const err = !draft.rows.length ? "Pick a role." : draft.rows.some((r) => !r.preset && !r.role?.trim()) ? "Name the custom role."
    : size > room ? `Room for ${room} more (max ${h.maxParticipants}).` : null;
  const add = async () => {
    if (busy || err) return;
    setBusy(true);
    try {
      for (const { key: _k, ...e } of draft.rows) await api.addHuddleParticipants(slug, h.id, { ...e, focus: e.focus?.trim() || undefined });
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="huddle-add">
      <RosterEditor presets={presets} draft={draft} setDraft={setDraft} tickets={[]} hostId={h.hostTicket} max={DEFAULT_MAX} onEnter={add} disabled={busy} hideMain />
      <div className="huddle-card-actions">
        <span className="muted small">{err ?? (h.status === "live" ? "They start right away." : "They start when you resume the huddle.")}</span>
        <span className="spacer" />
        <button className="btn small" onClick={onDone}>Cancel</button>
        <button className="btn primary small" onClick={add} disabled={busy || !!err}>{busy ? "Adding…" : "Add"}</button>
      </div>
    </div>
  );
}
