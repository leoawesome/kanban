import { useState } from "react";
import type { Ticket } from "./api";
import { Markdown } from "./Transcript";

type Draft = { title: string; description: string };

/** Tickets a planner's chat proposed; Create adds each to Backlog, linked to the planner. */
export function NewTicketsCard({ drafts, created, onCreate, onOpen }: {
  drafts: Draft[];
  /** The planner's existing child for a draft (matched by title), if it was created already. */
  created: (d: Draft) => Ticket | undefined;
  onCreate: (d: Draft) => Promise<Ticket | null>;
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());
  // Bridges the gap until the new ticket arrives over SSE, so a fast second click can't create it twice.
  const [made, setMade] = useState<Map<number, Ticket>>(new Map());
  const createdAt = (d: Draft, i: number) => created(d) ?? made.get(i);
  const missing = drafts.map((d, i) => ({ d, i })).filter(({ d, i }) => !createdAt(d, i));
  const toggle = (set: Set<number>, i: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(i);
    else next.delete(i);
    return next;
  };

  const create = async (d: Draft, i: number) => {
    if (busy.has(i)) return;
    setBusy((b) => toggle(b, i, true));
    try {
      const t = await onCreate(d);
      if (t) setMade((m) => new Map(m).set(i, t));
    } finally {
      setBusy((b) => toggle(b, i, false));
    }
  };
  // One at a time, so the tickets land in Backlog in the proposed order.
  const createAll = async () => {
    for (const { d, i } of missing) await create(d, i);
  };

  return (
    <div className={`proposal new-tickets ${missing.length ? "" : "applied"}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed tickets · {drafts.length}</span>
        {missing.length > 1 && (
          <button className="btn primary small" disabled={busy.size > 0} onClick={createAll}>
            {busy.size > 0 ? "Creating…" : `Create all ${missing.length}`}
          </button>
        )}
      </div>
      {drafts.map((d, i) => {
        const t = createdAt(d, i);
        return (
          <div key={i} className={`new-ticket ${t ? "applied" : ""}`}>
            <div className="new-ticket-head">
              <button className="link-btn new-ticket-title" aria-expanded={open.has(i)}
                onClick={() => setOpen((o) => toggle(o, i, !o.has(i)))}>
                {open.has(i) ? "▾" : "▸"} {d.title}
              </button>
              {t ? (
                <button className="link-btn small" onClick={() => onOpen(t.id)}>Created → {t.title}</button>
              ) : (
                <button className="btn small" disabled={busy.has(i)} onClick={() => create(d, i)}>
                  {busy.has(i) ? "Creating…" : "Create"}
                </button>
              )}
            </div>
            {open.has(i) && d.description && <div className="proposal-body"><Markdown text={d.description} /></div>}
          </div>
        );
      })}
      <span className="muted small">
        {missing.length ? "Each lands in Backlog, linked to this ticket. Nothing starts until you move it." : "All created. They're in Backlog."}
      </span>
    </div>
  );
}
