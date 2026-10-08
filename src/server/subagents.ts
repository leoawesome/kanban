import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A subagent Claude started with the Agent (older: Task) tool, shown as its own row in the chat. */
export const AGENT_TOOL = /^(?:Agent|Task)$/;

export type AgentStatus = "running" | "done" | "failed" | "stopped";

/** One thing a subagent did: a tool call (same label as the parent's tool lines) or a message it wrote. */
export interface AgentStep {
  kind: "tool" | "text";
  text: string;
  /** Tool calls: the tool_use id (its full input and output load from the tool endpoint). */
  id?: string;
  /** Tool calls whose result was an error. */
  error?: true;
}

export interface AgentInfo {
  /** The parent's Agent tool_use id (links the row to the subagent's transcript). */
  toolUseId: string;
  description: string;
  /** subagent_type, e.g. Explore; null when the call didn't name one. */
  type: string | null;
  background: boolean;
  status: AgentStatus;
  startedAt: string;
  endedAt: string | null;
  /** Last time anything was written for it (parent or its own transcript). */
  updatedAt: string;
  /** The steps sent to the chat (the conversation endpoint keeps only the last few); stepCount counts all. */
  steps: AgentStep[];
  stepCount: number;
  /** Label of the tool call it is in the middle of (running agents only). */
  current: string | null;
  /** Its final report (markdown). */
  result: string | null;
  error: string | null;
}

const TOOL_ARG_KEYS = ["file_path", "command", "url", "pattern", "query", "description", "prompt"];

export function toolLabel(block: any): string {
  const input = block.input ?? {};
  const key = TOOL_ARG_KEYS.find((k) => typeof input[k] === "string" && input[k]);
  const arg = key ? String(input[key]).split("\n")[0].slice(0, 120) : "";
  return arg ? `${block.name}: ${arg}` : String(block.name);
}

/** What a subagent's own transcript (subagents/agent-<id>.jsonl) says about it. */
export interface AgentTranscript {
  steps: AgentStep[];
  current: string | null;
  /** Its last message when it ended its turn (end_turn): the final report. */
  final: string | null;
  startedAt: string | null;
  lastAt: string | null;
}

/** Intermediate messages are clipped: the row is a progress view, the full report shows as the result. */
const STEP_TEXT_MAX = 600;

export function parseAgentTranscript(raw: string): AgentTranscript {
  const steps: AgentStep[] = [];
  const open = new Map<string, string>();
  const byId = new Map<string, AgentStep>();
  let final: string | null = null;
  let startedAt: string | null = null;
  let lastAt: string | null = null;
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
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    if (ev.type === "user") {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        open.delete(b.tool_use_id);
        const step = byId.get(b.tool_use_id);
        if (step && b.is_error) step.error = true;
      }
      continue;
    }
    if (ev.type !== "assistant") continue;
    // Claude Code writes one line per content block; only the last block of a turn carries stop_reason.
    const ended = ev.message?.stop_reason === "end_turn";
    final = null;
    for (const b of content) {
      if (b?.type === "tool_use") {
        const label = toolLabel(b);
        const step: AgentStep = { kind: "tool", text: label };
        steps.push(step);
        if (typeof b.id === "string") {
          step.id = b.id;
          byId.set(b.id, step);
          open.set(b.id, label);
        }
      } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const text = b.text.trim();
        if (ended) final = text;
        else steps.push({ kind: "text", text: text.length > STEP_TEXT_MAX ? `${text.slice(0, STEP_TEXT_MAX)}…` : text });
      }
    }
  }
  return { steps, current: [...open.values()].at(-1) ?? null, final, startedAt, lastAt };
}

interface Cached {
  key: string;
  toolUseId: string | null;
  transcript: AgentTranscript;
}

/**
 * Reads a session's subagent transcripts (<session dir>/subagents/agent-<id>.jsonl + .meta.json naming the
 * parent's tool_use id), re-parsing a file only when its size/mtime change.
 */
export class SubagentCache {
  private files = new Map<string, Cached>();

  /** Cheap change marker for the subagents folder of a session file ("" when there is none). */
  version(sessionFile: string): string {
    const dir = subagentsDir(sessionFile);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return "";
    }
    let size = 0, mtime = 0, n = 0;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const s = statSync(join(dir, name));
        size += s.size;
        mtime = Math.max(mtime, s.mtimeMs);
        n++;
      } catch {}
    }
    return n ? `${n}:${size}:${mtime}` : "";
  }

  /** Transcripts by the parent's tool_use id. */
  load(sessionFile: string): Map<string, AgentTranscript> {
    const dir = subagentsDir(sessionFile);
    const out = new Map<string, AgentTranscript>();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      let key = "";
      try {
        const s = statSync(file);
        key = `${s.size}:${s.mtimeMs}`;
      } catch {
        continue;
      }
      let hit = this.files.get(file);
      if (!hit || hit.key !== key || !hit.toolUseId) {
        let raw = "";
        try {
          raw = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        hit = { key, toolUseId: readToolUseId(file.replace(/\.jsonl$/, ".meta.json")), transcript: parseAgentTranscript(raw) };
        this.files.set(file, hit);
      }
      if (hit.toolUseId) out.set(hit.toolUseId, hit.transcript);
    }
    return out;
  }
}

/** A session's subagent transcript files (empty when there are none). */
export function subagentFiles(sessionFile: string): string[] {
  const dir = subagentsDir(sessionFile);
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function subagentsDir(sessionFile: string): string {
  return join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
}

function readToolUseId(metaFile: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    return typeof meta?.toolUseId === "string" ? meta.toolUseId : null;
  } catch {
    return null;
  }
}

/** The parent's view of an agent, filled in with what its own transcript shows. */
export function withTranscript(a: AgentInfo, t: AgentTranscript | undefined): AgentInfo {
  if (!t) return a;
  const out: AgentInfo = { ...a, steps: t.steps, stepCount: t.steps.length };
  if (t.lastAt && t.lastAt > out.updatedAt) out.updatedAt = t.lastAt;
  // The parent hears about the end a moment later (sync result or background notification).
  if (out.status === "running" && t.final !== null && !t.current) {
    out.status = "done";
    out.endedAt = t.lastAt;
  }
  if (out.status === "running") out.current = t.current;
  if (!out.result && out.status === "done") out.result = t.final;
  return out;
}

/** Background agents report back as a <task-notification> message to the parent. */
export function parseTaskNotification(text: string): { toolUseId: string; status: string; result: string | null } | null {
  if (!text.includes("<task-notification>")) return null;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
  if (!toolUseId || !status) return null;
  const result = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1]?.trim() ?? null;
  return { toolUseId, status, result: result || null };
}

/** Status words in task notifications → the row's status. */
export function notifiedStatus(status: string): AgentStatus {
  if (status === "completed") return "done";
  if (status === "killed" || status === "stopped") return "stopped";
  return "failed";
}

/** No word from a running agent for this long while the ticket isn't running: it was cut off. */
export const AGENT_STALE_MS = 60_000;

/** Shown as stopped instead of spinning forever once its run is gone and it went quiet. */
export function settleAgent(a: AgentInfo, runActive: boolean, now = Date.now()): AgentInfo {
  if (a.status !== "running" || runActive) return a;
  const last = Date.parse(a.updatedAt);
  if (Number.isFinite(last) && now - last < AGENT_STALE_MS) return a;
  return { ...a, status: "stopped", current: null };
}

/** Steps a chat row gets up front; the rest load on "show all". */
export const AGENT_STEP_TAIL = 20;
