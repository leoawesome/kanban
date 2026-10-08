import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useLayer } from "./layers";
import { matchCommands, SLASH_GROUPS, slashQuery, sourceLabel, type SlashCommand } from "./slashText";

const GAP = 6;
const STALE_MS = 30_000;

// Per ticket (its worktree decides the project skills); refetched when older than STALE_MS.
const cache = new Map<string, { at: number; list: SlashCommand[] }>();

/** What `/` can run in this ticket's chat. null while loading. */
export function useSlashCommands(slug: string, ticketId: string): SlashCommand[] | null {
  const key = `${slug}/${ticketId}`;
  const [list, setList] = useState<SlashCommand[] | null>(() => cache.get(key)?.list ?? null);
  useEffect(() => {
    setList(cache.get(key)?.list ?? null);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < STALE_MS) return;
    let live = true;
    api.commands(slug, ticketId).then((l) => {
      cache.set(key, { at: Date.now(), list: l });
      if (live) setList(l);
    }).catch(() => {});
    return () => { live = false; };
  }, [key]);
  return list;
}

/**
 * `/name` picker for the chat composer, like Claude Code's: typing `/` as the message's first character lists
 * skills, custom commands and built-ins in sections. ↑↓ choose, Enter/Tab insert `/name ` (not send), Esc closes.
 * Wire `handlers` onto the textarea and call `onKeyDown` first in its key handler (true = handled).
 */
export function useSlashPicker({ commands, ref, setValue }: {
  commands: SlashCommand[] | null;
  ref: RefObject<HTMLTextAreaElement | null>;
  setValue: (v: string) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Esc closes the picker until the message no longer starts with "/".
  const dismissed = useRef(false);
  const caret = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const matches = query !== null && commands ? matchCommands(commands, query) : [];
  const open = query !== null && matches.length > 0;

  useLayer(() => {
    dismissed.current = true;
    setQuery(null);
  }, { active: open });

  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  // Keep the chosen row in view while arrowing through a long list.
  useLayoutEffect(() => {
    list.current?.querySelector(".slash-item.on")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const update = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setQuery(null);
    if (!el.value.startsWith("/")) dismissed.current = false;
    const next = dismissed.current ? null : slashQuery(el.value, el.selectionStart);
    if (next !== query) setActive(0);
    setQuery(next);
  };

  const insert = (i: number) => {
    const el = ref.current;
    const c = matches[i];
    if (!el || !c) return;
    // Replace the first word, keep whatever was typed after it.
    const rest = el.value.replace(/^\/\S*\s?/, "");
    const head = `/${c.name} `;
    caret.current = head.length;
    setValue(head + rest);
    setQuery(null);
  };

  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    const go = (d: number) => setActive((a) => (a + d + matches.length) % matches.length);
    if (e.key === "ArrowDown") go(1);
    else if (e.key === "ArrowUp") go(-1);
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) insert(active);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  let popup: React.ReactNode = null;
  const el = ref.current;
  if (open && el) {
    const rect = el.getBoundingClientRect();
    const width = Math.min(560, Math.max(300, rect.width - 24));
    const style: CSSProperties = { left: Math.min(rect.left + 12, window.innerWidth - width - 8), width };
    if (rect.top > 300) style.bottom = window.innerHeight - rect.top + GAP;
    else style.top = rect.bottom + GAP;
    let n = 0;
    popup = createPortal(
      <div ref={list} className="snippet-pop slash-pop" role="listbox" aria-label="Slash commands" style={style} onMouseDown={(e) => e.preventDefault()}>
        {SLASH_GROUPS.map((g) => {
          const items = matches.filter((c) => c.kind === g.kind);
          if (!items.length) return null;
          return (
            <div key={g.kind} role="group" aria-label={g.label}>
              <div className="slash-group">{g.label}</div>
              {items.map((c) => {
                const i = n++;
                return (
                  <div key={c.name} role="option" aria-selected={i === active} className={`slash-item${i === active ? " on" : ""}`}
                    onMouseEnter={() => setActive(i)} onClick={() => insert(i)}>
                    <b title={`/${c.name}`}>
                      {/* A long plugin namespace gives way first: the skill's own name stays readable. */}
                      <span className="slash-ns">/{c.name.includes(":") ? c.name.slice(0, c.name.lastIndexOf(":") + 1) : ""}</span>
                      <span className="slash-name">{c.name.slice(c.name.lastIndexOf(":") + 1)}</span>
                    </b>
                    <span title={c.description}>{c.description}</span>
                    <em className="snippet-scope">{sourceLabel(c)}</em>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div className="snippet-foot">Type to filter · {matches.length} available</div>
      </div>,
      document.body,
    );
  }

  return {
    popup,
    onKeyDown,
    /** Spread on the textarea; re-checks the `/query` whenever the text or caret moves. */
    handlers: { onSelect: update, onBlur: () => setQuery(null) },
  };
}
