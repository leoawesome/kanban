// A huddle participant's own Claude session, read-only, for the Huddle tab's session viewer: what the agent thought,
// the tools it ran (full input and output load from tooldetail) and what it posted. The transcript is Claude Code's
// session file, found by the participant's sessionId under ~/.claude/projects; it stays there after the huddle closes
// and its snapshot worktree is removed, so nothing is copied.
import { readFileSync, statSync } from "node:fs";
import type { Bus } from "./events";
import { HuddleError, type Huddles } from "./huddle";
import { USER_HANDLE } from "./huddle-roster";
import type { Store } from "./store";
import { toolLabel } from "./subagents";
import type { ToolDetail } from "./tooldetail";
import type { HuddleMode, HuddleParticipantKind, HuddleParticipantStatus } from "./types";

/** One thing the agent did, in session order. */
export interface SessionStep {
  /** Position in the session (paging goes by it). */
  i: number;
  /** text: its reasoning or a message; tool: a tool call; post: a huddle_post call; wake: a prompt it got (start, new messages). */
  kind: "text" | "tool" | "post" | "wake";
  /** text: the text (clipped); tool: its label (same as the chat's tool rows); post: what it posted; wake: a short note. */
  text: string;
  at: string | null;
  /** tool and post: the tool_use id (full input and output load from the tool endpoint). */
  id?: string;
  /** tool: a short look at the output (its one line, or how many lines). */
  out?: string;
  error?: true;
  /** tool and post: no result yet (it is running, or the session was cut off). */
  pending?: true;
  /** post: the message number the huddle gave it. */
  seq?: number;
}

export interface ParsedHuddleSession {
  steps: SessionStep[];
  startedAt: string | null;
  lastAt: string | null;
}

/** Longest text step sent; the transcript file has the rest. */
export const STEP_TEXT_MAX = 4000;
const OUT_MAX = 140;
const POST_TOOL = /(?:^|__)huddle_post$/;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : "")).join("\n");
}

/** A tool output in a few words: its only line, else how many lines (an error: its first line). */
export function outputSummary(text: string, error = false): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return error ? "error" : "no output";
  if (lines.length === 1 || error) return clip(lines[0], OUT_MAX);
  return `${lines.length} lines`;
}

export function parseHuddleSession(raw: string): ParsedHuddleSession {
  const steps: SessionStep[] = [];
  const byId = new Map<string, SessionStep>();
  let startedAt: string | null = null;
  let lastAt: string | null = null;
  const push = (s: Omit<SessionStep, "i">) => {
    const step = { i: steps.length, ...s } as SessionStep;
    steps.push(step);
    return step;
  };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof ev.timestamp === "string" ? ev.timestamp : null;
    if (at) {
      startedAt ??= at;
      lastAt = at;
    }
    if (ev.isSidechain || ev.isMeta) continue;
    const content = ev.message?.content;
    if (ev.type === "user") {
      if (typeof content === "string" || (Array.isArray(content) && !content.some((b: any) => b?.type === "tool_result"))) {
        const text = typeof content === "string" ? content : content.map((b: any) => (b?.type === "text" ? b.text ?? "" : "")).join("\n");
        if (!text.trim() || /^\s*(<|\[Request interrupted|Caveat:)/.test(text)) continue;
        push({ kind: "wake", text: steps.some((s) => s.kind === "wake") ? "Woke up with new huddle messages" : "Started on its job", at });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const step = byId.get(b.tool_use_id);
        if (!step) continue;
        delete step.pending;
        const text = resultText(b.content);
        if (b.is_error) step.error = true;
        if (step.kind === "post") {
          const seq = /Posted #(\d+)/.exec(text)?.[1];
          if (seq) step.seq = Number(seq);
          else if (b.is_error) step.out = outputSummary(text, true);
        } else step.out = outputSummary(text, !!b.is_error);
      }
      continue;
    }
    if (ev.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use") {
        const post = POST_TOOL.test(String(b.name ?? ""));
        const step = post
          ? push({ kind: "post", text: clip(String(b.input?.text ?? "").trim(), STEP_TEXT_MAX), at, pending: true })
          : push({ kind: "tool", text: toolLabel(b), at, pending: true });
        if (typeof b.id === "string") {
          step.id = b.id;
          byId.set(b.id, step);
        }
      } else if ((b?.type === "text" || b?.type === "thinking") && typeof (b.text ?? b.thinking) === "string") {
        const text = String(b.text ?? b.thinking).trim();
        if (text) push({ kind: "text", text: clip(text, STEP_TEXT_MAX), at });
      }
    }
  }
  return { steps, startedAt, lastAt };
}

/** Where to find session files (SessionCache in the daemon). */
export interface SessionFiles {
  file(sessionId: string): string | null;
  toolDetail(sessionId: string, toolUseId: string): ToolDetail | null;
}

/** Parsed sessions by file, re-read only when the file's size or mtime change. */
export class HuddleSessionCache {
  private items = new Map<string, { key: string; parsed: ParsedHuddleSession }>();

  get(file: string): ParsedHuddleSession | null {
    let key: string;
    try {
      const s = statSync(file);
      key = `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
    const hit = this.items.get(file);
    if (hit?.key === key) return hit.parsed;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const parsed = parseHuddleSession(raw);
    this.items.set(file, { key, parsed });
    return parsed;
  }
}

/** The session viewer's response: the participant (as the roster shows it), its file and a page of its steps. */
export interface ParticipantSession {
  handle: string;
  kind: HuddleParticipantKind;
  role: string;
  /** The model it runs with (the board's default when the participant names none; null: Claude Code's default). */
  model: string | null;
  mode: HuddleMode;
  status: HuddleParticipantStatus;
  /** It is in the middle of a turn now. */
  live: boolean;
  costUsd: number;
  sessionId: string | null;
  snapshot: { branch: string | null; sha: string } | null;
  /** ticket-main: its session is that ticket's chat (the viewer links there). */
  ticketId: string | null;
  /** The transcript file (null: not written yet, or a ticket's session). */
  file: string | null;
  steps: SessionStep[];
  /** Steps in the whole session; hasMore: older ones before the first sent. */
  total: number;
  hasMore: boolean;
  /** The step it is on now (live only). */
  current: number | null;
}

export const SESSION_PAGE = 200;

/**
 * A participant's session. Paging: newest last; `before` (a step index) pages back, `since` gives every step from
 * that index on (a live view refreshing what it has).
 */
export function participantSession(
  huddles: Huddles, store: Store, files: SessionFiles, cache: HuddleSessionCache, slug: string, hid: string, handle: string,
  q: { before?: number; since?: number; limit?: number } = {},
): ParticipantSession {
  const h = huddles.get(slug, hid);
  const p = huddles.view(slug, h).participants.find((x) => x.handle === handle);
  if (!p || p.kind === "human") throw new HuddleError(404, handle === USER_HANDLE ? "@you has no session" : `no participant @${handle}`);
  const agent = p.kind === "agent";
  const file = agent && p.sessionId ? files.file(p.sessionId) : null;
  const parsed = file ? cache.get(file) : null;
  const all = parsed?.steps ?? [];
  const limit = Math.max(1, Math.min(1000, Math.floor(q.limit ?? SESSION_PAGE)));
  let steps: SessionStep[];
  if (q.since !== undefined) steps = all.slice(Math.max(0, Math.floor(q.since)));
  else {
    const end = q.before === undefined ? all.length : Math.max(0, Math.min(all.length, Math.floor(q.before)));
    steps = all.slice(Math.max(0, end - limit), end);
  }
  const live = agent && p.running && p.status === "working";
  const current = live ? all.findLast((s) => s.pending)?.i ?? null : null;
  return {
    handle: p.handle, kind: p.kind, role: p.role, model: agent ? p.model ?? store.getProfile(slug)?.model ?? null : p.model, mode: p.mode,
    status: p.status, live, costUsd: p.costUsd ?? 0, sessionId: agent ? p.sessionId : null, snapshot: p.snapshot ?? null,
    ticketId: p.kind === "ticket-main" ? p.ticketId ?? null : null, file,
    steps, total: all.length, hasMore: (steps[0]?.i ?? all.length) > 0, current,
  };
}

/** One full tool call of a participant's session; null when the participant, its session or the call isn't there. */
export function participantTool(huddles: Huddles, files: SessionFiles, slug: string, hid: string, handle: string, toolUseId: string): ToolDetail | null {
  const p = huddles.get(slug, hid).participants.find((x) => x.handle === handle);
  if (!p) throw new HuddleError(404, `no participant @${handle}`);
  return p.kind === "agent" && p.sessionId ? files.toolDetail(p.sessionId, toolUseId) : null;
}

/** Huddles closed this recently are still watched: an agent's last lines land just after the close stops it. */
const CLOSED_GRACE_MS = 2 * 60_000;

/**
 * One pass: a huddle.session event for each agent whose session file changed since the last pass (the first pass
 * only takes note). Change markers come from `version` (SessionCache.version: size and mtime).
 */
export function pollHuddleSessions(store: Store, bus: Bus, version: (sessionId: string) => string | null, state: Map<string, string>, first: boolean, now = Date.now()): void {
  const seen = new Set<string>();
  for (const profile of store.listProfiles()) {
    for (const h of store.listHuddles(profile.slug)) {
      if (h.status === "closed" && !(h.closedAt && now - Date.parse(h.closedAt) < CLOSED_GRACE_MS)) continue;
      for (const p of h.participants) {
        if (p.kind !== "agent" || !p.sessionId) continue;
        const key = `${profile.slug}/${h.id}/${p.handle}`;
        seen.add(key);
        const v = version(p.sessionId);
        if (!v || state.get(key) === v) continue;
        const known = state.has(key);
        state.set(key, v);
        if (first && !known) continue;
        bus.emit({ type: "huddle.session", profile: profile.slug, huddleId: h.id, handle: p.handle });
      }
    }
  }
  for (const k of state.keys()) if (!seen.has(k)) state.delete(k);
}

/** Polls huddle agents' session files (every 2 s, like the ticket session watcher); the event is the viewer's cue to refetch. */
export function startHuddleSessionWatcher(store: Store, bus: Bus, version: (sessionId: string) => string | null, intervalMs = 2000): () => void {
  const state = new Map<string, string>();
  let first = true;
  const tick = () => {
    try {
      pollHuddleSessions(store, bus, version, state, first);
    } catch (e) {
      console.error("huddle session watcher", e);
    }
    first = false;
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
