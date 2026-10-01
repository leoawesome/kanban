import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "./icons";
import { useLayer } from "./layers";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  hint?: string;
}

/** "⋯" overflow menu at the end of the top bar for things you need now and then. ↑↓ move, Esc closes. */
export function HeaderMenu({ items, footer }: { items: MenuItem[]; footer?: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useLayer(() => {
    setOpen(false);
    button.current?.focus();
  }, { active: open });

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="header-menu" ref={root}>
      <button ref={button} className="icon-btn more-btn" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <MoreIcon size={16} />
      </button>
      {open && (
        <div className="inbox-menu header-menu-list" role="menu" ref={menu} onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.label} role="menuitem" className="menu-item" onClick={() => { setOpen(false); it.onSelect(); }}>
              <span className="menu-icon" aria-hidden>{it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
          {footer && <div className="menu-footer muted small">{footer}</div>}
        </div>
      )}
    </div>
  );
}
