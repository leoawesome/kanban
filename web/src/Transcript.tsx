import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import type { ActivityEntry } from "./api";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return JSON.stringify(content, null, 2);
}

function toolLabel(block: any): string {
  const i = block.input ?? {};
  const arg = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? i.path ?? i.query ?? "";
  return `${block.name}${arg ? `: ${String(arg).split("\n")[0]}` : ""}`;
}

// Transcript/comment text is untrusted (Claude output, repo content). No forms/inputs/styles: a
// disguised same-origin form could otherwise drive the local API, which runs Claude unattended.
const PURIFY = {
  FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style", "iframe", "object", "embed"],
  FORBID_ATTR: ["style", "action", "formaction"],
};

// Pasted images: the UI URL, or the absolute file path Claude was given in its prompt (seen in the chat history).
const ATTACHMENT_SRC = /(?:^|\/)attachments\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/;

function thumbnails(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    const m = (img.getAttribute("src") ?? "").match(ATTACHMENT_SRC);
    if (!m) return;
    img.setAttribute("src", `/api/attachments/${m[1]}`);
    img.classList.add("attachment");
  });
  return doc.body.innerHTML;
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => thumbnails(DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, PURIFY)), [text]);
  return (
    <div className="md" dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const img = e.target as HTMLElement;
        if (img.tagName === "IMG" && img.classList.contains("attachment")) window.open(img.getAttribute("src")!, "_blank", "noopener");
      }} />
  );
}

function Event({ ev }: { ev: any }) {
  if (ev.type === "system" && ev.subtype === "init") {
    return <div className="ev ev-system">Session started · {ev.model ?? "claude"} · <code>{ev.cwd}</code></div>;
  }
  if (ev.type === "assistant") {
    const blocks: any[] = ev.message?.content ?? [];
    return (
      <>
        {blocks.map((b, i) => {
          if (b.type === "text" && b.text?.trim()) {
            return <div key={i} className="ev ev-text"><Markdown text={b.text.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim()} /></div>;
          }
          if (b.type === "tool_use") {
            return (
              <details key={i} className="ev ev-tool">
                <summary>{toolLabel(b)}</summary>
                <pre>{JSON.stringify(b.input, null, 2)}</pre>
              </details>
            );
          }
          if (b.type === "thinking" && b.thinking) {
            return (
              <details key={i} className="ev ev-thinking">
                <summary>Thinking</summary>
                <pre>{b.thinking}</pre>
              </details>
            );
          }
          return null;
        })}
      </>
    );
  }
  if (ev.type === "user") {
    const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    return (
      <>
        {blocks.filter((b) => b.type === "tool_result").map((b, i) => {
          const out = textOf(b.content);
          return (
            <details key={i} className={`ev ev-result ${b.is_error ? "is-error" : ""}`}>
              <summary>{b.is_error ? "Tool error" : "Result"} · {out.split("\n").length} lines</summary>
              <pre>{out.length > 8000 ? out.slice(0, 8000) + "\n…(truncated)" : out}</pre>
            </details>
          );
        })}
      </>
    );
  }
  if (ev.type === "result") {
    const cost = typeof ev.total_cost_usd === "number" ? `$${ev.total_cost_usd.toFixed(3)}` : null;
    const secs = typeof ev.duration_ms === "number" ? `${Math.round(ev.duration_ms / 1000)}s` : null;
    return (
      <div className={`ev ev-footer ${ev.is_error ? "is-error" : ""}`}>
        {ev.is_error ? "Run ended with error" : "Run finished"}
        {secs && ` · ${secs}`}
        {cost && ` · ${cost}`}
        {typeof ev.num_turns === "number" && ` · ${ev.num_turns} turns`}
      </div>
    );
  }
  return null;
}

export function Transcript({ entries, live }: { entries: ActivityEntry[]; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => {
    const m = new Map<number, ActivityEntry[]>();
    for (const e of entries) {
      if (!m.has(e.run)) m.set(e.run, []);
      m.get(e.run)!.push(e);
    }
    return [...m.entries()];
  }, [entries]);

  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, live]);

  if (!entries.length) return <div className="muted">No runs yet.</div>;
  return (
    <div className="transcript">
      {runs.map(([run, evs]) => (
        <div key={run} className="run">
          <div className="run-head">
            Run {run} <span className="muted">· {new Date(evs[0].at).toLocaleString()}</span>
          </div>
          {evs.map((e, i) => <Event key={i} ev={e.event} />)}
        </div>
      ))}
      {live && <div className="ev ev-live"><span className="spinner" /> Working…</div>}
      <div ref={endRef} />
    </div>
  );
}
