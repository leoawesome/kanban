import { useMemo, useState } from "react";
import { COLUMNS, type Ticket } from "./api";
import { Modal } from "./Modal";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Board",
    keys: [
      [["N"], "New ticket"],
      [["/"], "Search tickets"],
      [["Esc"], "Clear the search"],
      [[MOD, "K"], "Jump to a ticket"],
      [["Ctrl", "`"], "Terminal & files panel"],
      [["?"], "This list"],
    ],
  },
  {
    title: "Cards (focus one with Tab)",
    keys: [
      [["Enter"], "Open the ticket"],
      [["Space"], "Pick up / drop the card"],
      [["↑", "↓", "←", "→"], "Move a picked-up card"],
      [["Esc"], "Cancel the move"],
    ],
  },
  {
    title: "Ticket panel",
    keys: [
      [["Enter"], "Send a chat message"],
      [["Shift", "Enter"], "New line"],
      [[MOD, "Enter"], "Save the description"],
      [[MOD, "\\"], "Show / hide details"],
      [["Esc"], "Close (one layer at a time)"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="form shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.keys.map(([keys, what]) => (
                <div key={what} className="shortcut-row">
                  <dt>{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Lower is better; null = no match. Letters must appear in order; word starts and runs score best. */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return direct === 0 || /\W/.test(t[direct - 1]) ? -1000 + direct : -500 + direct;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, last + 1);
    if (i < 0) return null;
    score += i - last - 1;
    last = i;
  }
  return score;
}

/** ⌘K: type part of a title, Enter opens it. */
export function QuickSwitcher({ tickets, onPick, onClose }: { tickets: Ticket[]; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const shown = useMemo(() => {
    const scored = tickets.map((t) => ({ t, s: fuzzyScore(t.title, q) })).filter((x) => x.s !== null) as { t: Ticket; s: number }[];
    // No query: most recently touched first.
    if (!q.trim()) return tickets.slice().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 50);
    return scored.sort((a, b) => a.s - b.s).slice(0, 50).map((x) => x.t);
  }, [tickets, q]);
  const pick = (i: number) => shown[i] && onPick(shown[i].id);

  return (
    <Modal title="Jump to a ticket" onClose={onClose}>
      <div className="form switcher">
        <input autoFocus value={q} placeholder="Type part of a title…" aria-label="Ticket title"
          role="combobox" aria-expanded aria-controls="switcher-list" aria-activedescendant={shown[active] ? `sw-${shown[active].id}` : undefined}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(active); }
          }} />
        <div className="switcher-list" id="switcher-list" role="listbox" aria-label="Tickets">
          {shown.length === 0 && <div className="picker-empty">No ticket matches.</div>}
          {shown.map((t, i) => (
            <div key={t.id} id={`sw-${t.id}`} role="option" aria-selected={i === active}
              className={`switcher-item${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}
              ref={(el) => { if (el && i === active) el.scrollIntoView({ block: "nearest" }); }}>
              <span className="switcher-title">{t.title}</span>
              <span className="muted small">{COLUMNS.find((c) => c.id === t.status)?.label}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
