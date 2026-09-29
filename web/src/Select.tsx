import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

/** Styled dropdown replacing the native <select>. Keyboard: Enter/Space/↓ open, ↑↓ move, Enter pick, Esc close. */
export function Select<T extends string>({ value, options, onChange, footer, className, ariaLabel, renderValue }: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  /** Extra items under a divider, e.g. "New profile…". */
  footer?: { label: ReactNode; onSelect: () => void }[];
  className?: string;
  ariaLabel?: string;
  renderValue?: (o: SelectOption<T> | undefined) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = [
    ...options.map((o) => ({ kind: "option" as const, o })),
    ...(footer ?? []).map((f) => ({ kind: "footer" as const, f })),
  ];
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openMenu = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === "option") {
      if (it.o.disabled) return;
      onChange(it.o.value);
    } else {
      it.f.onSelect();
    }
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`select ${open ? "open" : ""} ${className ?? ""}`} ref={root} onKeyDown={onKey}>
      <button type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}>
        <span className="select-value">{renderValue ? renderValue(current) : current?.label ?? "Select…"}</span>
        <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="select-menu" role="listbox">
          {items.map((it, i) =>
            it.kind === "option" ? (
              <div key={it.o.value} role="option" aria-selected={it.o.value === value} aria-disabled={it.o.disabled}
                className={`select-item ${i === active ? "active" : ""} ${it.o.value === value ? "selected" : ""} ${it.o.disabled ? "disabled" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <span className="select-check" aria-hidden>{it.o.value === value ? "✓" : ""}</span>
                <span className="select-label">{it.o.label}{it.o.hint && <span className="select-hint">{it.o.hint}</span>}</span>
              </div>
            ) : (
              <div key={`f${i}`} className={`select-item footer ${i === active ? "active" : ""} ${i === options.length ? "first-footer" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <span className="select-check" aria-hidden>+</span>
                <span className="select-label">{it.f.label}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
