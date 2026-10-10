import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import type { ActivityEntry } from "./api";
import { opensNewTab } from "./links";
import { sourceLabel, splitCommandMentions, type SlashCommand } from "./slashText";

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

function thumbnails(html: string, commands?: SlashCommand[] | null, handles?: string[]): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (commands?.length) mentionChips(doc, commands);
  if (handles?.length) handleChips(doc, handles);
  doc.querySelectorAll("img").forEach((img) => {
    const m = (img.getAttribute("src") ?? "").match(ATTACHMENT_SRC);
    if (!m) return;
    img.setAttribute("src", `/api/attachments/${m[1]}`);
    img.classList.add("attachment");
  });
  // Clicking a link must not replace the board: open it in a new tab.
  doc.querySelectorAll("a").forEach((a) => {
    if (!opensNewTab(a.getAttribute("href"))) return;
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  return doc.body.innerHTML;
}

/** `/name` of a known skill or command in prose (not code or links) becomes a chip; hover tells what it is. */
function mentionChips(doc: Document, commands: SlashCommand[]) {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    if (!text.includes("/") || node.parentElement?.closest("code, pre, a")) continue;
    const parts = splitCommandMentions(text, (n) => byName.has(n));
    if (parts.every((p) => typeof p === "string")) continue;
    const frag = doc.createDocumentFragment();
    for (const p of parts) {
      if (typeof p === "string") { frag.append(p); continue; }
      const c = byName.get(p.name)!;
      const chip = doc.createElement("span");
      chip.className = "cmd-chip mention";
      chip.textContent = `/${p.name}`;
      chip.title = `${c.kind === "skill" ? "Skill" : "Command"} · ${sourceLabel(c)}${c.description ? `\n${c.description}` : ""}`;
      frag.append(chip);
    }
    node.replaceWith(frag);
  }
}

/** `@handle` of a huddle participant (or @all) in prose (not code or links) becomes a chip. */
function handleChips(doc: Document, handles: string[]) {
  const known = new Set(handles.map((h) => h.toLowerCase()));
  const re = /(^|[^\w@./-])@([a-z0-9][a-z0-9_-]*)/gi;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    if (!text.includes("@") || node.parentElement?.closest("code, pre, a")) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      const name = m[2].replace(/[-_]+$/, "");
      if (!known.has(name.toLowerCase())) continue;
      const at = m.index! + m[1].length;
      frag.append(text.slice(last, at));
      const chip = doc.createElement("span");
      chip.className = "at-chip";
      chip.textContent = `@${name}`;
      frag.append(chip);
      last = at + 1 + name.length;
    }
    if (!last) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** `commands`: `/name` mentions of these render as chips (ticket descriptions). `handles`: `@handle` mentions (huddles). */
export function Markdown({ text, commands, handles }: { text: string; commands?: SlashCommand[] | null; handles?: string[] }) {
  const html = useMemo(
    () => thumbnails(DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, PURIFY), commands, handles),
    [text, commands, handles?.join(" ")],
  );
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
