import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "./api";

/** Top-bar "N need you" across every board; the list jumps straight to a ticket. */
export function Inbox({ items, onPick }: { items: InboxItem[]; onPick: (i: InboxItem) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items.length) return null;
  const boards = [...new Set(items.map((i) => i.profile))];

  return (
    <div className="inbox" ref={root}>
      <button className="inbox-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        title="Tickets on any board where Claude is waiting on you">
        <span className="yt-dot" aria-hidden /> {items.length} need you
      </button>
      {open && (
        <div className="inbox-menu" role="menu">
          {boards.map((b) => {
            const group = items.filter((i) => i.profile === b);
            return (
              <div key={b} className="inbox-group">
                <div className="inbox-board">{group[0].profileName}</div>
                {group.map((i) => (
                  <button key={i.id} role="menuitem" className="inbox-item" onClick={() => { setOpen(false); onPick(i); }}>
                    <span className="inbox-title">{i.title}</span>
                    <span className={`inbox-why att-${i.attention.kind}`}>{i.attention.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
