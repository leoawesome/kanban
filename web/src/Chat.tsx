import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribe, type SessionEntry, type Ticket } from "./api";
import { ArrowDownIcon, CloseIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { ProposalCard } from "./ProposalCard";
import { QuestionsForm } from "./QuestionsForm";
import { draftKey, formKey } from "./drafts";
import { fullTime, timeAgo, useNow } from "./time";
import { toast } from "./toast";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";

type Block = { kind: "entry"; e: SessionEntry; index: number } | { kind: "tools"; items: SessionEntry[] };

function group(entries: SessionEntry[]): Block[] {
  const out: Block[] = [];
  entries.forEach((e, index) => {
    const prev = out.at(-1);
    if (e.kind === "tool") {
      if (prev?.kind === "tools") prev.items.push(e);
      else out.push({ kind: "tools", items: [e] });
    } else out.push({ kind: "entry", e, index });
  });
  return out;
}

/** What to show of a half-written reply: hide board blocks (questions/proposal JSON) and the result line. */
function liveView(text: string): { text: string; preparing: string | null } {
  const cut = text.indexOf("<ckanban-");
  const visible = (cut >= 0 ? text.slice(0, cut) : text).replace(/^CKANBAN_RESULT.*$/gm, "").trim();
  if (cut < 0) return { text: visible, preparing: null };
  const rest = text.slice(cut);
  return {
    text: visible,
    preparing: rest.startsWith("<ckanban-questions") ? "Preparing questions…" : rest.startsWith("<ckanban-ticket") ? "Preparing ticket proposal…" : null,
  };
}

const REFINE = (s: Ticket["status"]) => s === "backlog" || s === "planning";

/** Grows the textarea with its text (about 8 lines), then it scrolls. */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  const max = Math.min(window.innerHeight * 0.3, 8 * 22 + 8);
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

// Image links reach the session as local file paths, so compare by file name.
const norm = (s: string) => s.trim().replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");
/** Whether a message the user sent is in the session file yet. */
const delivered = (entries: SessionEntry[], text: string) => entries.some((e) => e.role === "user" && norm(e.text) === norm(text));

/**
 * The ticket's single conversation with Claude, like the terminal: everything in the session
 * (terminal chat, board runs, messages typed here) in one timeline, plus a box to send more.
 */
/** Stop Claude with instant feedback: "Stopping…" from the click until the run is gone. */
export function useStop(slug: string, ticket: Ticket, working: boolean, onError: (m: string) => void) {
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (!working) setClicked(false);
  }, [working]);
  const stopping = working && (clicked || ticket.lastActivity === "Stopping…");
  const stop = () => {
    setClicked(true);
    api.stop(slug, ticket.id).catch((e) => {
      setClicked(false);
      onError(e.message);
    });
  };
  return { stopping, stop };
}

export function Chat({ slug, ticket, onError }: { slug: string; ticket: Ticket; onError: (m: string) => void }) {
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Scrolled up: offer a jump back down; "fresh" = something new arrived meanwhile.
  const [jump, setJump] = useState<{ fresh: boolean } | null>(null);
  const [showWarnDetails, setShowWarnDetails] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  useNow();
  // Sent messages not yet in the session file (the server's queue covers ones Claude hasn't read).
  const [pending, setPending] = useState<string[]>([]);
  const queued = ticket.queued ?? [];
  // Unsent text survives closing the drawer, switching tickets and reloads.
  const [draft, setDraft] = usePersistentState(draftKey(slug, ticket.id), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const images = useImagePaste(setDraft);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Text Claude is writing right now (from the run's partial-message stream); not yet in the session file.
  const [live, setLive] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = !!ticket.running;
  const { stopping, stop } = useStop(slug, ticket, running, onError);
  const refine = REFINE(ticket.status);

  const loadTail = useCallback(async () => {
    if (!ticket.sessionId) return setPage({ entries: [], start: 0 });
    const r = await api.conversation(slug, ticket.id);
    setPage((prev) => {
      if (!prev || r.start <= prev.start) return { entries: r.entries, start: r.start };
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      return idx >= 0 ? { entries: [...prev.entries.slice(0, idx), ...r.entries], start: prev.start } : { entries: r.entries, start: r.start };
    });
  }, [slug, ticket.id, ticket.sessionId]);

  const reload = useCallback(() => {
    setLoadError(null);
    loadTail().catch((e) => {
      setLoadError(e.message);
      setPage((p) => p ?? { entries: [], start: 0 });
    });
  }, [loadTail]);
  useEffect(() => {
    setPage(null);
    reload();
  }, [reload]);
  useLayoutEffect(() => autoGrow(composer.current), [draft]);

  // Live updates: session file changes (terminal) and run activity (board) both refresh the tail.
  useEffect(() => subscribe((e) => {
    if (e.type === "draft" && e.profile === slug && e.id === ticket.id) {
      if (e.text) setLive(e.text);
      // Message finished: swap the live copy for the saved one without a gap.
      else loadTail().catch(() => {}).finally(() => setLive(""));
      return;
    }
    const mine = (e.type === "session.updated" || e.type === "activity") && e.profile === slug && e.id === ticket.id;
    if (!mine || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTail().catch(() => {});
    }, 700);
  }), [slug, ticket.id, loadTail]);

  // A run just finished: pick up the final message even if no more events arrive.
  useEffect(() => {
    if (!running) loadTail().catch(() => {}).finally(() => setLive(""));
  }, [running]);

  // Claude read a queued message: keep its bubble until the session file shows it, so it doesn't blink out.
  const prevQueued = useRef(queued);
  useEffect(() => {
    const read = prevQueued.current.filter((q) => q.state === "queued" && !queued.some((n) => n.id === q.id)).map((q) => q.text);
    prevQueued.current = queued;
    if (read.length) setPending((ps) => [...ps, ...read]);
  }, [ticket.queued]);

  const entries = page?.entries ?? [];
  // Drop optimistic bubbles once the session file contains the message.
  useEffect(() => {
    if (pending.some((p) => delivered(entries, p))) setPending((ps) => ps.filter((p) => !delivered(entries, p)));
  }, [entries, pending]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else setJump((j) => (j ? { fresh: true } : j));
  }, [page, pending, running, live]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setJump(null);
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || stopping || images.uploading) return;
    images.clearError();
    stickToBottom.current = true;
    setPending((ps) => [...ps, t]);
    setDraft("");
    try {
      const r = await api.chat(slug, ticket.id, t);
      // Steering: the server queue now shows it.
      if (r.queued?.some((q) => q.text === t)) setPending((ps) => ps.filter((p) => p !== t));
    } catch (e: any) {
      setPending((ps) => ps.filter((p) => p !== t));
      setDraft(t);
      onError(e.message);
    }
  };

  const loadEarlier = async () => {
    if (!page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await api.conversation(slug, ticket.id, page.start);
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setPage((prev) => ({ entries: [...r.entries, ...(prev?.entries ?? [])], start: r.start }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const answeredAfter = (index: number) => entries.slice(index + 1).some((e) => e.role === "user" && e.kind === "text");
  const isApplied = (p: { title: string; description: string }) =>
    (!p.title || p.title === ticket.title) && (!p.description || p.description.trim() === ticket.body.trim());

  const empty = page !== null && !loadError && entries.length === 0 && !pending.length && !queued.length && !running;

  const applyProposal = async (p: { title: string; description: string }) => {
    const before = { title: ticket.title, body: ticket.body };
    try {
      await api.updateTicket(slug, ticket.id, {
        ...(p.title ? { title: p.title } : {}),
        ...(p.description ? { body: p.description } : {}),
      });
      toast("Applied to the ticket", {
        tone: "ok",
        action: {
          label: "Undo",
          run: () => api.updateTicket(slug, ticket.id, before).catch((err) => toast(`Undo failed: ${err.message}`, { tone: "error" })),
        },
      });
    } catch (err: any) {
      onError(err.message);
    }
  };

  return (
    <div className="chat">
      <div className="chat-log" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickToBottom.current = gap < 60;
          if (gap < 60) setJump(null);
          else if (gap > 240) setJump((j) => j ?? { fresh: false });
        }}>
        {page === null && <div className="muted"><span className="spinner" /> Loading the conversation…</div>}
        {loadError && (
          <div className="banner error inline load-error" role="alert">
            Couldn't load the conversation: {loadError}{" "}
            <button className="link-btn" onClick={reload}>Retry</button>
          </div>
        )}
        {page && page.start > 0 && (
          <button className="btn ghost small load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? "Loading…" : `Load earlier (${page.start} more)`}
          </button>
        )}
        {empty && (
          <div className="chat-empty">
            {ticket.status === "backlog" ? (
              <>
                <p><b>Parked.</b> Move it to Planning when you want Claude to help shape it: it will ask a few questions, then propose a clear title and description.</p>
                <button className="btn" onClick={() => api.updateTicket(slug, ticket.id, { status: "planning" }).catch((e) => onError(e.message))}>
                  Move to Planning
                </button>
              </>
            ) : ticket.status === "planning" ? (
              <>
                {/* Only shown if the automatic start didn't happen (e.g. session was open in a terminal). */}
                <p><b>Shape this ticket with Claude.</b> Describe your idea below, or let Claude start the interview.</p>
                <button className="btn" onClick={() => send("Help me refine this ticket. Interview me about what's unclear, then propose an improved title and description.")}>
                  Start the interview
                </button>
              </>
            ) : (
              <p className="muted">No conversation yet. Move the card to Ready to let Claude work on it, or send a message.</p>
            )}
          </div>
        )}
        {group(entries).map((b) => {
          if (b.kind === "tools") {
            return (
              <details key={b.items[0].uuid} className="conv-tools">
                <summary>{b.items.length === 1 ? b.items[0].text : `${b.items.length} tool calls · ${b.items.at(-1)!.text}`}</summary>
                <ul>{b.items.map((t) => <li key={t.uuid}>{t.text}</li>)}</ul>
              </details>
            );
          }
          const e = b.e;
          if (e.kind === "board") {
            return <div key={e.uuid} className="chat-note">{e.text}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</div>;
          }
          return (
            <div key={e.uuid} className={`conv-msg ${e.role}`}>
              <div className="conv-head">
                <b>{e.role === "user" ? "You" : "Claude"}</b>
                {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
              </div>
              {e.text && <Markdown text={e.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim()} />}
              {e.questions && (
                <QuestionsForm questions={e.questions} answered={answeredAfter(b.index)} disabled={running} onSubmit={send}
                  storageKey={formKey(slug, ticket.id, e.uuid)} />
              )}
              {e.proposal && (
                <ProposalCard proposal={e.proposal} applied={isApplied(e.proposal)} onApply={() => applyProposal(e.proposal!)} />
              )}
              {e.moved === "planning" && (
                <div className="chat-moved">
                  Moved to <b>Planning</b>: this was a planning request, so nothing was changed. Answer or refine here, then
                  drag the card to Ready when you want Claude to do it.
                </div>
              )}
            </div>
          );
        })}
        {live && (
          <div className="conv-msg assistant live" aria-live="polite">
            <div className="conv-head"><b>Claude</b><span className="muted small">writing…</span></div>
            {liveView(live).text && <Markdown text={liveView(live).text} />}
            {liveView(live).preparing && <div className="chat-typing"><span className="spinner" /> {liveView(live).preparing}</div>}
          </div>
        )}
        {running && !live && (
          <div className="chat-typing"><span className="spinner" /> {ticket.lastActivity && ticket.lastActivity !== "Starting…" ? ticket.lastActivity : "Claude is working…"}</div>
        )}
        {pending.filter((p) => !queued.some((q) => q.text === p)).map((p, i) => (
          <div key={i} className="conv-msg user pending">
            <div className="conv-head"><b>You</b><span className="muted small">sending…</span></div>
            <Markdown text={p} />
          </div>
        ))}
        {queued.map((q) => (
          <div key={q.id} className={`conv-msg user pending${q.state === "unsent" ? " unsent" : ""}`}>
            <div className="conv-head">
              <b>You</b>
              <span className="muted small">{q.state === "queued" ? "queued · Claude reads this at its next step" : "not sent · Claude was stopped before reading it"}</span>
            </div>
            <Markdown text={q.text} />
            {q.state === "unsent" && (
              <div className="queued-actions">
                <button className="btn primary small" disabled={stopping}
                  onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                <button className="btn ghost small"
                  onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
              </div>
            )}
          </div>
        ))}
        {!running && ticket.error && !ticket.error.startsWith("corrupt") && (
          <div className="banner error inline"><pre>{ticket.error}</pre></div>
        )}
        {ticket.notice && (
          <div className="banner info inline notice" role="status">
            <span>{ticket.notice}</span>
            <button className="icon-btn" aria-label="Dismiss" title="Dismiss"
              onClick={() => api.updateTicket(slug, ticket.id, { notice: null }).catch((e) => onError(e.message))}><CloseIcon size={12} /></button>
          </div>
        )}
        {/* Sticky inside the log, so it floats just above the composer. */}
        {jump && (
          <button className={`jump-latest${jump.fresh ? " fresh" : ""}`} onClick={toBottom}>
            <ArrowDownIcon size={12} /> {jump.fresh ? "New messages" : "Jump to latest"}
          </button>
        )}
      </div>

      {ticket.terminalOpen && !running && (
        <div className="composer-warn">
          Also open in your terminal: type in one place at a time.{" "}
          <button className="link-btn small" aria-expanded={showWarnDetails} onClick={() => setShowWarnDetails((v) => !v)}>
            {showWarnDetails ? "Less" : "Why?"}
          </button>
          {showWarnDetails && (
            <div className="composer-warn-more">
              Sending here works, but if you type in both places at once the two conversations can get mixed up.
            </div>
          )}
        </div>
      )}
      <div className="composer">
        <textarea ref={composer} rows={2} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
          placeholder={running ? "Steer Claude: it reads this at its next step, no restart…" : refine ? "Describe your idea or answer Claude…" : "Ask Claude to change or continue something…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }} />
        {images.error && <div className="form-error">{images.error}</div>}
        <div className="composer-foot">
          <span className="muted small composer-hint">
            {refine ? "Refine mode: Claude won't change files." : "Claude acts on your message."}
            <span className="composer-keys"> Enter to send · Shift+Enter for a new line</span>
          </span>
          <span className="composer-actions">
            {running && <button className="btn danger small" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop"}</button>}
            <button className="btn primary small" disabled={!draft.trim() || stopping || images.uploading} onClick={() => send(draft)}>{images.uploading ? "Uploading…" : "Send"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
