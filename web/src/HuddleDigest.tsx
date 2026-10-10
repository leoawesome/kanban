import type { ReactNode } from "react";
import { digestSenders, parseDigest } from "./huddleText";
import { Markdown } from "./Transcript";

/**
 * Huddle messages the board delivered to this ticket's session, shown as a collapsible huddle entry (not a user
 * bubble): "🗣 Huddle · N messages · from @x, @y", the [#n] entries inside, a link to the Huddle tab.
 */
export function HuddleDigest({ text, meta, old, pending, onOpen, children }: {
  text: string;
  /** Right side of the header: time, or the queued state. */
  meta?: ReactNode;
  old?: boolean;
  pending?: boolean;
  onOpen?: () => void;
  /** Shown under the block, outside the fold (Send / Discard for an unsent one). */
  children?: ReactNode;
}) {
  const { entries, note, brief } = parseDigest(text);
  const senders = digestSenders(entries);
  const n = entries.length;
  const block = (
    <details className={`conv-msg peer in huddle-digest${old ? " inherited" : ""}${pending ? " pending" : ""}`}>
      <summary className="conv-head">
        <b><span aria-hidden>🗣</span> Huddle</b>
        <span className="muted small hdg-sum">
          · {n} message{n === 1 ? "" : "s"}{senders.length > 0 && <> · from {senders.map((s) => `@${s}`).join(", ")}</>}
        </span>
        {meta}
      </summary>
      {brief && <div className="muted small hdg-brief" title={brief}>📌 Brief: {brief.split("\n")[0]}</div>}
      {note && <div className="muted small">{note}</div>}
      {n === 0 ? <Markdown text={text} /> : (
        <ol className="hdg-list">
          {entries.map((e) => (
            <li key={e.seq} className={e.from ? "" : "system"}>
              <span className="hdg-who">[#{e.seq}] {e.from ? `@${e.from}` : "(system)"}{e.finding ? " (finding)" : ""}</span>
              <Markdown text={e.text} />
            </li>
          ))}
        </ol>
      )}
      {onOpen && <button type="button" className="link-btn small" onClick={onOpen}>Open the Huddle tab →</button>}
    </details>
  );
  return children ? <div className="hdg-wrap">{block}{children}</div> : block;
}
