import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Bus } from "./events";
import type { Store } from "./store";

/** One visible item of a Claude Code session, as shown in the ticket's Conversation tab. */
export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  kind: "text" | "tool";
  text: string;
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
}

/** What the board card and ticket header need; sent over SSE. */
export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: SessionArtifact[];
  updatedAt: string;
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

function userText(content: unknown): string | null {
  if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    content = content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
  }
  if (typeof content !== "string") return null;
  const t = content.trim();
  // Slash-command wrappers, hook output and skill preambles are stored as user messages too.
  if (!t || t.startsWith("<") || /^(Base directory for this skill|Caveat:|\[Request interrupted)/.test(t)) return null;
  return t;
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
      const text = userText(content);
      if (text && !ev.isMeta) entries.push({ uuid, at, role: "user", kind: "text", text });
      continue;
    }

    if (!Array.isArray(content)) continue;
    content.forEach((b: any, i: number) => {
      const id = i ? `${uuid}:${i}` : uuid;
      if (b?.type === "text" && b.text?.trim()) entries.push({ uuid: id, at, role: "assistant", kind: "text", text: b.text.trim() });
      else if (b?.type === "tool_use") entries.push({ uuid: id, at, role: "assistant", kind: "tool", text: toolLabel(b) });
    });
  }

  const last = entries.findLast((e) => e.kind === "text");
  return {
    title: customTitle ?? aiTitle,
    entries,
    artifacts: [...artifacts.values()],
    lastMessage: last ? { role: last.role, text: last.text, at: last.at } : null,
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
    return { title: p.title, lastMessage: p.lastMessage, artifacts: p.artifacts, updatedAt };
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
