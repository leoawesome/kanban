import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribe, type SessionEntry } from "./api";
import { timeAgo } from "./time";
import { Markdown } from "./Transcript";

type Block = { kind: "msg"; e: SessionEntry } | { kind: "tools"; items: SessionEntry[] };

function group(entries: SessionEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    const prev = out.at(-1);
    if (e.kind === "tool") {
      if (prev?.kind === "tools") prev.items.push(e);
      else out.push({ kind: "tools", items: [e] });
    } else out.push({ kind: "msg", e });
  }
  return out;
}

/** Read-only view of the ticket's Claude Code session (terminal chat + board runs). Live-updates. */
export function Conversation({ slug, ticketId, resumeCommand }: { slug: string; ticketId: string; resumeCommand?: string | null }) {
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(null);
  const entries = page?.entries ?? null;
  const start = page?.start ?? 0;
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);

  const loadTail = useCallback(async () => {
    const r = await api.conversation(slug, ticketId);
    setPage((prev) => {
      // Keep already-loaded older pages when the tail refreshes.
      if (!prev || r.start <= prev.start) return { entries: r.entries, start: r.start };
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      return idx >= 0
        ? { entries: [...prev.entries.slice(0, idx), ...r.entries], start: prev.start }
        : { entries: r.entries, start: r.start };
    });
  }, [slug, ticketId]);

  useEffect(() => {
    setPage(null);
    api.conversation(slug, ticketId)
      .then((r) => setPage({ entries: r.entries, start: r.start }))
      .catch(() => setPage({ entries: [], start: 0 }));
  }, [slug, ticketId]);

  useEffect(() => subscribe((e) => {
    if (e.type === "session.updated" && e.profile === slug && e.id === ticketId) loadTail().catch(() => {});
  }), [slug, ticketId, loadTail]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const loadEarlier = async () => {
    if (!entries || start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await api.conversation(slug, ticketId, start);
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setPage((prev) => ({ entries: [...r.entries, ...(prev?.entries ?? [])], start: r.start }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  if (entries === null) return <div className="muted">Loading conversation…</div>;
  if (!entries.length) return <div className="muted">No conversation yet.</div>;

  return (
    <div className="conversation" ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}>
      {start > 0 && (
        <button className="btn ghost small load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>
          {loadingEarlier ? "Loading…" : `Load earlier (${start} more)`}
        </button>
      )}
      {group(entries).map((b, i) =>
        b.kind === "tools" ? (
          <details key={b.items[0].uuid} className="conv-tools">
            <summary>{b.items.length === 1 ? b.items[0].text : `${b.items.length} tool calls · ${b.items.at(-1)!.text}`}</summary>
            <ul>{b.items.map((t) => <li key={t.uuid}>{t.text}</li>)}</ul>
          </details>
        ) : (
          <div key={b.e.uuid + i} className={`conv-msg ${b.e.role}`}>
            <div className="conv-head">
              <b>{b.e.role === "user" ? "You" : "Claude"}</b>
              {b.e.at && <span className="muted small" title={new Date(b.e.at).toLocaleString()}>{timeAgo(b.e.at)}</span>}
            </div>
            <Markdown text={b.e.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim()} />
          </div>
        ),
      )}
      {resumeCommand && (
        <div className="conv-footer muted small">Read-only. To reply, continue in your terminal: <code>{resumeCommand}</code></div>
      )}
    </div>
  );
}
