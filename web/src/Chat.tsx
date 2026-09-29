import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribe, type SessionEntry, type Ticket } from "./api";
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

const REFINE = (s: Ticket["status"]) => s === "backlog" || s === "planning";

/**
 * The ticket's single conversation with Claude, like the terminal: everything in the session
 * (terminal chat, board runs, messages typed here) in one timeline, plus a box to send more.
 */
export function Chat({ slug, ticket, onError }: { slug: string; ticket: Ticket; onError: (m: string) => void }) {
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = !!ticket.running;
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
    const mine = (e.type === "session.updated" || e.type === "activity") && e.profile === slug && e.id === ticket.id;
    if (!mine || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTail().catch(() => {});
    }, 700);
  }), [slug, ticket.id, loadTail]);

  // A run just finished: pick up the final message even if no more events arrive.
  useEffect(() => {
    if (!running) loadTail().catch(() => {});
  }, [running]);

  const entries = page?.entries ?? [];
  // Drop the optimistic bubble once the session file contains the message.
  useEffect(() => {
    if (pending && entries.some((e) => e.role === "user" && e.text.trim() === pending.trim())) setPending(null);
  }, [entries, pending]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [page, pending, running]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || running) return;
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
            {refine ? (
              <>
                <p><b>Shape this ticket with Claude.</b> Tell it your idea in your own words. It will ask a few questions, then propose a clear title and description you can apply.{ticket.status === "backlog" ? " (Moving the card to Planning starts this automatically.)" : ""}</p>
                <button className="btn" onClick={() => send("Help me refine this ticket. Interview me about what's unclear, then propose an improved title and description.")}>
                  Help me refine this ticket
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
            </div>
          );
        })}
        {pending && (
          <div className="conv-msg user pending">
            <div className="conv-head"><b>You</b><span className="muted small">sending…</span></div>
            <Markdown text={pending} />
          </div>
        )}
        {running && (
          <div className="chat-typing"><span className="spinner" /> {ticket.lastActivity && ticket.lastActivity !== "Starting…" ? ticket.lastActivity : "Claude is working…"}</div>
        )}
        {!running && ticket.error && !ticket.error.startsWith("corrupt") && (
          <div className="banner error inline"><pre>{ticket.error}</pre></div>
        )}
      </div>

      <div className="composer">
        <textarea rows={2} value={draft} disabled={running}
          placeholder={running ? "Claude is replying…" : refine ? "Describe your idea or answer Claude…" : "Ask Claude to change or continue something…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }} />
        <div className="composer-foot">
          <span className="muted small">
            {refine ? "Refine mode: Claude won't change any files." : "Claude will act on your message, like in the terminal."} Enter to send, Shift+Enter for a new line.
          </span>
          {running
            ? <button className="btn danger small" onClick={() => api.stop(slug, ticket.id).catch((e) => onError(e.message))}>Stop</button>
            : <button className="btn primary small" disabled={!draft.trim()} onClick={() => send(draft)}>Send</button>}
        </div>
      </div>
    </div>
  );
}
