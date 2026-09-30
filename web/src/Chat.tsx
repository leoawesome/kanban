import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribe, type SessionEntry, type Ticket } from "./api";
import { useImagePaste } from "./imagePaste";
import { ProposalCard } from "./ProposalCard";
import { QuestionsForm } from "./QuestionsForm";
import { timeAgo } from "./time";
import { Markdown } from "./Transcript";

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
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  useEffect(() => {
    setPage(null);
    loadTail().catch(() => setPage({ entries: [], start: 0 }));
  }, [loadTail]);

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

  const entries = page?.entries ?? [];
  // Drop the optimistic bubble once the session file contains the message.
  useEffect(() => {
    // Image links reach the session as local file paths, so compare by file name.
    const norm = (s: string) => s.trim().replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");
    if (pending && entries.some((e) => e.role === "user" && norm(e.text) === norm(pending))) setPending(null);
  }, [entries, pending]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [page, pending, running, live]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || running || images.uploading) return;
    images.clearError();
    stickToBottom.current = true;
    setPending(t);
    setDraft("");
    try {
      await api.chat(slug, ticket.id, t);
    } catch (e: any) {
      setPending(null);
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

  const empty = page !== null && entries.length === 0 && !pending && !running;

  return (
    <div className="chat">
      <div className="chat-log" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}>
        {page === null && <div className="muted">Loading…</div>}
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
            return <div key={e.uuid} className="chat-note">{e.text}{e.at && <span> · {timeAgo(e.at)}</span>}</div>;
          }
          return (
            <div key={e.uuid} className={`conv-msg ${e.role}`}>
              <div className="conv-head">
                <b>{e.role === "user" ? "You" : "Claude"}</b>
                {e.at && <span className="muted small" title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>}
              </div>
              {e.text && <Markdown text={e.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim()} />}
              {e.questions && (
                <QuestionsForm questions={e.questions} answered={answeredAfter(b.index)} disabled={running} onSubmit={send} />
              )}
              {e.proposal && (
                <ProposalCard proposal={e.proposal} applied={isApplied(e.proposal)}
                  onApply={async () => {
                    try {
                      await api.updateTicket(slug, ticket.id, {
                        ...(e.proposal!.title ? { title: e.proposal!.title } : {}),
                        ...(e.proposal!.description ? { body: e.proposal!.description } : {}),
                      });
                    } catch (err: any) {
                      onError(err.message);
                    }
                  }} />
              )}
              {e.moved === "planning" && (
                <div className="chat-moved">
                  ↩ Moved to <b>Planning</b>: this was a planning request, so nothing was changed. Answer or refine here, then
                  drag the card to Ready when you want Claude to do it.
                </div>
              )}
            </div>
          );
        })}
        {pending && (
          <div className="conv-msg user pending">
            <div className="conv-head"><b>You</b><span className="muted small">sending…</span></div>
            <Markdown text={pending} />
          </div>
        )}
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
        {!running && ticket.error && !ticket.error.startsWith("corrupt") && (
          <div className="banner error inline"><pre>{ticket.error}</pre></div>
        )}
      </div>

      {ticket.terminalOpen && !running && (
        <div className="composer-warn">
          This session is also open in your terminal. Sending here works, but if you type in both places at once the two
          conversations can get mixed up. Easiest: continue in one place.
        </div>
      )}
      <div className="composer">
        <textarea rows={2} value={draft} disabled={running} className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
          placeholder={running ? "Claude is replying…" : refine ? "Describe your idea or answer Claude…" : "Ask Claude to change or continue something…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }} />
        {images.error && <div className="form-error">{images.error}</div>}
        <div className="composer-foot">
          <span className="muted small">
            {refine ? "Refine mode: Claude won't change any files." : "Claude will act on your message, like in the terminal."} Enter to send, Shift+Enter for a new line.
          </span>
          {running
            ? <button className="btn danger small" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop"}</button>
            : <button className="btn primary small" disabled={!draft.trim() || images.uploading} onClick={() => send(draft)}>{images.uploading ? "Uploading…" : "Send"}</button>}
        </div>
      </div>
    </div>
  );
}
