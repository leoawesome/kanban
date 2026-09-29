import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Bus } from "./events";
import type { Store } from "./store";

/** One visible item of a Claude Code session, as shown in the ticket's Conversation tab. */
export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
}

export interface Question {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface TicketProposal {
  title: string;
  description: string;
}

export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  /** board: a prompt the board sent on the user's behalf (instructions hidden). */
  kind: "text" | "tool" | "board";
  text: string;
  /** Interview questions Claude asked (rendered as a form). */
  questions?: Question[];
  /** Improved title/description Claude proposed (rendered with an Apply button). */
  proposal?: TicketProposal;
}

const CONTEXT_TAG = "<ckanban-context";
const QUESTIONS_RE = /<ckanban-questions>([\s\S]*?)<\/ckanban-questions>/;
const TICKET_RE = /<ckanban-ticket>([\s\S]*?)<\/ckanban-ticket>/;

function parseQuestions(json: string): Question[] | null {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v) || !v.length) return null;
    const qs = v.map((q: any) => ({
      question: String(q?.question ?? "").trim(),
      multiSelect: !!q?.multiSelect,
      options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
        label: String(o?.label ?? "").trim(),
        description: typeof o?.description === "string" && o.description ? o.description : undefined,
        recommended: !!o?.recommended,
      })).filter((o: QuestionOption) => o.label),
    }));
    return qs.every((q) => q.question) ? qs : null;
  } catch {
    return null;
  }
}

function parseProposal(json: string): TicketProposal | null {
  try {
    const v = JSON.parse(json);
    const title = typeof v?.title === "string" ? v.title.trim() : "";
    const description = typeof v?.description === "string" ? v.description.trim() : "";
    return title || description ? { title, description } : null;
  } catch {
    return null;
  }
}

/** Split an assistant text block into visible text + structured questions/proposal. */
function assistantBlock(text: string): Pick<SessionEntry, "text" | "questions" | "proposal"> {
  let out = text;
  let questions: Question[] | undefined;
  let proposal: TicketProposal | undefined;
  const q = out.match(QUESTIONS_RE);
  const parsedQ = q ? parseQuestions(q[1].trim()) : null;
  if (q && parsedQ) {
    questions = parsedQ;
    out = out.replace(q[0], "");
  }
  const t = out.match(TICKET_RE);
  const parsedT = t ? parseProposal(t[1].trim()) : null;
  if (t && parsedT) {
    proposal = parsedT;
    out = out.replace(t[0], "");
  }
  return { text: out.trim(), ...(questions ? { questions } : {}), ...(proposal ? { proposal } : {}) };
}

export interface SessionArtifact {
  url: string;
  label: string;
  at: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ParsedSession {
  title: string | null;
  entries: SessionEntry[];
  artifacts: SessionArtifact[];
  lastMessage: SessionMessage | null;
  /** Questions Claude asked since the user's last message. */
  openQuestions: number;
  /** Latest ticket proposal since the user's last message. */
  pendingProposal: TicketProposal | null;
}

/** What the board card and ticket header need; sent over SSE. */
export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: SessionArtifact[];
  updatedAt: string;
  openQuestions: number;
  pendingProposal: TicketProposal | null;
}

interface Dirs {
  configDir?: string;
}

function projectsDir(d: Dirs): string {
  return join(d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

export function findSessionFile(sessionId: string, d: Dirs = {}): string | null {
  const root = projectsDir(d);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const f = join(root, dir, `${sessionId}.jsonl`);
    try {
      if (statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

const TOOL_ARG_KEYS = ["file_path", "command", "url", "pattern", "query", "description", "prompt"];
const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/g;

function userText(content: unknown): { kind: "text" | "board"; text: string } | null {
  if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    content = content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
  }
  if (typeof content !== "string") return null;
  const ctx = content.indexOf(CONTEXT_TAG);
  if (ctx >= 0) {
    // Board-sent prompt: show only what the user typed; pure instructions become a short note.
    const typed = content.slice(0, ctx).trim();
    if (typed) return { kind: "text", text: typed };
    const note = content.slice(ctx).match(/note="([^"]*)"/)?.[1];
    return { kind: "board", text: note || "Board sent instructions to Claude" };
  }
  const t = content.trim();
  // Slash-command wrappers, hook output and skill preambles are stored as user messages too.
  if (!t || t.startsWith("<") || /^(Base directory for this skill|Caveat:|\[Request interrupted)/.test(t)) return null;
  return { kind: "text", text: t };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

function toolLabel(block: any): string {
  const input = block.input ?? {};
  const key = TOOL_ARG_KEYS.find((k) => typeof input[k] === "string" && input[k]);
  const arg = key ? String(input[key]).split("\n")[0].slice(0, 120) : "";
  return arg ? `${block.name}: ${arg}` : String(block.name);
}

export function parseSession(raw: string): ParsedSession {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  const entries: SessionEntry[] = [];
  const artifacts = new Map<string, SessionArtifact>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "custom-title" && typeof ev.customTitle === "string") customTitle = ev.customTitle;
    else if (ev.type === "ai-title" && typeof ev.aiTitle === "string") aiTitle = ev.aiTitle;
    if ((ev.type !== "user" && ev.type !== "assistant") || ev.isSidechain) continue;
    const at = typeof ev.timestamp === "string" ? ev.timestamp : "";
    const uuid = typeof ev.uuid === "string" ? ev.uuid : `${entries.length}`;
    const content = ev.message?.content;

    if (ev.type === "user") {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          for (const m of resultText(b.content).matchAll(PUBLISHED)) {
            const label = basename(m[1]).replace(/\.[a-z0-9]+$/i, "");
            artifacts.delete(m[2]); // re-insert so the newest publish sorts last
            artifacts.set(m[2], { url: m[2], label, at });
          }
        }
      }
      const u = userText(content);
      if (u && !ev.isMeta) entries.push({ uuid, at, role: "user", kind: u.kind, text: u.text });
      continue;
    }

    if (!Array.isArray(content)) continue;
    content.forEach((b: any, i: number) => {
      const id = i ? `${uuid}:${i}` : uuid;
      if (b?.type === "text" && b.text?.trim()) entries.push({ uuid: id, at, role: "assistant", kind: "text", ...assistantBlock(b.text.trim()) });
      else if (b?.type === "tool_use") entries.push({ uuid: id, at, role: "assistant", kind: "tool", text: toolLabel(b) });
    });
  }

  const last = entries.findLast((e) => e.kind === "text" && (e.text || e.questions || e.proposal));
  const lastText = !last ? "" : last.text
    || (last.questions ? `Asked ${last.questions.length} question${last.questions.length > 1 ? "s" : ""}` : "Proposed an updated ticket");
  return {
    title: customTitle ?? aiTitle,
    entries,
    artifacts: [...artifacts.values()],
    lastMessage: last ? { role: last.role, text: lastText, at: last.at } : null,
    ...pendingSince(entries),
  };
}

function pendingSince(entries: SessionEntry[]): Pick<ParsedSession, "openQuestions" | "pendingProposal"> {
  let lastUser = -1;
  entries.forEach((e, i) => {
    if (e.role === "user" && e.kind === "text") lastUser = i;
  });
  const after = entries.slice(lastUser + 1);
  return {
    openQuestions: after.reduce((n, e) => n + (e.questions?.length ?? 0), 0),
    pendingProposal: after.findLast((e) => e.proposal)?.proposal ?? null,
  };
}

interface CacheItem {
  file: string;
  key: string;
  parsed: ParsedSession;
}

/** Parses session files lazily; re-reads only when size/mtime change. */
export class SessionCache {
  private items = new Map<string, CacheItem>();
  private files = new Map<string, string>();

  constructor(private dirs: Dirs = {}) {}

  private locate(sessionId: string): string | null {
    const known = this.files.get(sessionId);
    if (known) {
      try {
        statSync(known);
        return known;
      } catch {}
    }
    const f = findSessionFile(sessionId, this.dirs);
    if (f) this.files.set(sessionId, f);
    return f;
  }

  /** Cheap change marker for polling; null when the session file doesn't exist. */
  version(sessionId: string): string | null {
    const f = this.locate(sessionId);
    if (!f) return null;
    try {
      const s = statSync(f);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  get(sessionId: string): ParsedSession | null {
    const f = this.locate(sessionId);
    const key = this.version(sessionId);
    if (!f || !key) return null;
    const hit = this.items.get(sessionId);
    if (hit && hit.key === key && hit.file === f) return hit.parsed;
    let raw = "";
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      return null;
    }
    const parsed = parseSession(raw);
    this.items.set(sessionId, { file: f, key, parsed });
    return parsed;
  }

  summary(sessionId: string): SessionSummary | null {
    const p = this.get(sessionId);
    const f = this.locate(sessionId);
    if (!p || !f) return null;
    let updatedAt = "";
    try {
      updatedAt = statSync(f).mtime.toISOString();
    } catch {}
    return {
      title: p.title, lastMessage: p.lastMessage, artifacts: p.artifacts, updatedAt,
      openQuestions: p.openQuestions, pendingProposal: p.pendingProposal,
    };
  }
}

/** One polling pass: emit session.updated for every ticket whose session file changed since last pass. */
export function pollSessions(store: Store, bus: Bus, cache: SessionCache, state: Map<string, string>): void {
  const live = new Set<string>();
  for (const p of store.listProfiles()) {
    for (const t of store.listTickets(p.slug)) {
      if (!t.sessionId) continue;
      const key = `${p.slug}/${t.id}`;
      live.add(key);
      const v = cache.version(t.sessionId);
      if (!v || state.get(key) === `${t.sessionId}:${v}`) continue;
      state.set(key, `${t.sessionId}:${v}`);
      const session = cache.summary(t.sessionId);
      if (session) bus.emit({ type: "session.updated", profile: p.slug, id: t.id, session });
    }
  }
  for (const k of state.keys()) if (!live.has(k)) state.delete(k);
}

export function startSessionWatcher(store: Store, bus: Bus, cache: SessionCache, intervalMs = 2000): () => void {
  const state = new Map<string, string>();
  const timer = setInterval(() => {
    try {
      pollSessions(store, bus, cache, state);
    } catch (e) {
      console.error("session watcher", e);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
