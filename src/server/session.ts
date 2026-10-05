import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Bus } from "./events";
import { mockupName, stripMockups } from "./mockups";
import type { Store } from "./store";

/** One visible item of a Claude Code session, as shown in the ticket's Conversation tab. */
export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
  /** Mockup this option stands for (file name in outputs/mockups); the form links to its preview. */
  mockup?: string;
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

/** A ticket a planner's chat proposed creating; key/dependsOn order the plan. */
export interface NewTicketDraft extends TicketProposal {
  key?: string;
  dependsOn?: string[];
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
  /** New tickets Claude proposed splitting the work into (rendered with Create buttons). */
  newTickets?: NewTicketDraft[];
  /** Mockups Claude sent as blocks (saved to outputs/mockups; the chat links to them). */
  mockups?: string[];
  /** Claude asked the board to move the ticket (a planning-only request arrived in Review). */
  moved?: "planning";
  /** A board block whose JSON couldn't be read (left visible as text; the chat says so). */
  unreadable?: BlockKind;
  /** A ticket-to-ticket message (ask_ticket / reply_ticket): in = from that ticket's Claude, out = to it. */
  peer?: { dir: "in" | "out"; ticketId: string | null };
}

export type BlockKind = "questions" | "proposal" | "tickets";

/** Marker Claude adds when a Review message only asked for planning; the board moves the card. */
export const MOVE_TO_PLANNING_RE = /<ckanban-move\s+to="planning"\s*\/?>(?:\s*<\/ckanban-move>)?/;
/** A Review/Done chat reply that only proposed tickets: the card stays in its column. */
export const STAY_RE = /<ckanban-stay\s*\/?>(?:\s*<\/ckanban-stay>)?/;

const CONTEXT_TAG = "<ckanban-context";

/** End index (exclusive) of the JSON object/array starting at `from`, or -1 when it never closes. */
function jsonEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Find a `<tag>` block and parse its JSON. The JSON's own end decides where the block stops, so a wrong or
 * missing closing tag, or a closing tag quoted inside the JSON text, doesn't break it. A ```json fence around
 * the JSON is fine. Each occurrence of the opening tag is tried in order (prose may mention the tag before the
 * real block); the first whose content parses wins. `raw` is the block's text (to remove it), `value` null when
 * no occurrence parses (then `raw` is the first one).
 */
function findBlock<T>(text: string, tag: string, parse: (v: unknown) => T | null): { raw: string; value: T | null } | null {
  const open = `<${tag}>`;
  let first: string | null = null;
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + open.length)) {
    const head = /^\s*(?:```(?:json)?\s*)?/.exec(text.slice(start + open.length))![0];
    const from = start + open.length + head.length;
    const end = text[from] === "{" || text[from] === "[" ? jsonEnd(text, from) : -1;
    if (end < 0) {
      first ??= text.slice(start);
      continue;
    }
    const tail = /^(?:\s*```)?(?:\s*<\/[\w-]+>)?/.exec(text.slice(end))![0];
    const raw = text.slice(start, end + tail.length);
    let value: T | null = null;
    try {
      value = parse(JSON.parse(text.slice(from, end)));
    } catch {}
    if (value) return { raw, value };
    first ??= raw;
  }
  return first === null ? null : { raw: first, value: null };
}

export function parseQuestions(v: any): Question[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const qs = v.map((q: any) => ({
    question: String(q?.question ?? "").trim(),
    multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? "").trim(),
      description: typeof o?.description === "string" && o.description ? o.description : undefined,
      recommended: !!o?.recommended,
      ...(typeof o?.mockup === "string" && mockupName(o.mockup) ? { mockup: mockupName(o.mockup)! } : {}),
    })).filter((o: QuestionOption) => o.label),
  }));
  return qs.every((q) => q.question) ? qs : null;
}

export function parseProposal(v: any): TicketProposal | null {
  const title = typeof v?.title === "string" ? v.title.trim() : "";
  const description = typeof v?.description === "string" ? v.description.trim() : "";
  return title || description ? { title, description } : null;
}

export function parseNewTickets(v: any): NewTicketDraft[] | null {
  if (!Array.isArray(v)) return null;
  const ts = v.map((x: any) => {
    const d: NewTicketDraft = {
      title: typeof x?.title === "string" ? x.title.trim() : "",
      description: typeof x?.description === "string" ? x.description.trim() : "",
    };
    const key = typeof x?.key === "string" ? x.key.trim() : "";
    if (key) d.key = key;
    const deps = Array.isArray(x?.dependsOn) ? x.dependsOn.filter((k: unknown) => typeof k === "string" && k.trim()).map((k: string) => k.trim()) : [];
    if (deps.length) d.dependsOn = deps;
    return d;
  }).filter((x) => x.title);
  return ts.length ? ts : null;
}

/** Split an assistant text block into visible text + structured questions/proposal/new tickets. */
function assistantBlock(text: string): Pick<SessionEntry, "text" | "questions" | "proposal" | "newTickets" | "mockups" | "moved" | "unreadable"> {
  const { text: rest, names: mockups } = stripMockups(text);
  let out = rest;
  let moved: "planning" | undefined;
  if (MOVE_TO_PLANNING_RE.test(out)) {
    moved = "planning";
    out = out.replace(MOVE_TO_PLANNING_RE, "");
  }
  out = out.replace(STAY_RE, "");
  let unreadable: BlockKind | undefined;
  /** Parse one block and cut it from the text; an unreadable block stays visible and is flagged. */
  const take = <T>(tag: string, kind: BlockKind, parse: (v: unknown) => T | null): T | undefined => {
    const b = findBlock(out, tag, parse);
    if (!b) return undefined;
    if (!b.value) {
      unreadable ??= kind;
      return undefined;
    }
    out = out.replace(b.raw, "");
    return b.value;
  };
  const questions = take("ckanban-questions", "questions", parseQuestions);
  const proposal = take("ckanban-ticket", "proposal", parseProposal);
  const newTickets = take("ckanban-tickets", "tickets", parseNewTickets);
  return {
    text: out.trim(),
    ...(questions ? { questions } : {}),
    ...(proposal ? { proposal } : {}),
    ...(newTickets ? { newTickets } : {}),
    ...(mockups.length ? { mockups } : {}),
    ...(moved ? { moved } : {}),
    ...(unreadable ? { unreadable } : {}),
  };
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
  /** Latest proposed new tickets since the user's last message (some may already be created). */
  pendingNewTickets: TicketProposal[];
}

/** What the board card and ticket header need; sent over SSE. */
export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: SessionArtifact[];
  updatedAt: string;
  openQuestions: number;
  pendingProposal: TicketProposal | null;
  pendingNewTickets: TicketProposal[];
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

const HELPER_PUBLISH = /\bartifact publish\b/;

function isPublisher(block: any): boolean {
  if (block.name === "Artifact") return true;
  return block.name === "Bash" && typeof block.input?.command === "string" && HELPER_PUBLISH.test(block.input.command);
}

function userText(content: unknown): { kind: "text" | "board"; text: string; from?: string; question?: string } | null {
  if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    content = content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
  }
  if (typeof content !== "string") return null;
  const ctx = content.indexOf(CONTEXT_TAG);
  if (ctx >= 0) {
    // Board-sent prompt: show only what the user typed; pure instructions become a short note.
    const typed = content.slice(0, ctx).trim();
    const tag = content.slice(ctx, content.indexOf(">", ctx) + 1);
    // Sent by another ticket's Claude (a question, or a late reply): from="<ticket id>".
    const from = tag.match(/ from="([^"]*)"/)?.[1];
    if (typed && from) return { kind: "text", text: typed, from, question: tag.match(/ question="([^"]*)"/)?.[1] };
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

const ASK_TOOL = /(?:^|__)ask_ticket$/;
const REPLY_TOOL = /(?:^|__)reply_ticket$/;
/** Planning-chat tools (ckanban MCP): their input becomes a form or card, like the text blocks. */
const QUESTIONS_TOOL = /(?:^|__)ask_questions$/;
const PROPOSAL_TOOL = /(?:^|__)propose_ticket$/;
const TICKETS_TOOL = /(?:^|__)propose_tickets$/;
const REPLY_HEAD = /^Reply from ticket (\S+) .*:\n\n/;

/** The form or card a planning-chat tool call shows, or null for other tools (or input that can't be read). */
function cardEntry(block: any): Pick<SessionEntry, "questions" | "proposal" | "newTickets"> | null {
  const name = String(block.name ?? "");
  if (QUESTIONS_TOOL.test(name)) {
    const questions = parseQuestions(block.input?.questions);
    return questions && { questions };
  }
  if (PROPOSAL_TOOL.test(name)) {
    const proposal = parseProposal(block.input);
    return proposal && { proposal };
  }
  if (TICKETS_TOOL.test(name)) {
    const newTickets = parseNewTickets(block.input?.tickets);
    return newTickets && { newTickets };
  }
  return null;
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
  const publishers = new Set<string>();
  /** ask_ticket calls by tool_use id → asked ticket; question id → asking ticket. */
  const asks = new Map<string, string | null>();
  const askers = new Map<string, string>();
  /** Card tool calls (by tool_use id) and those whose result was an error: those don't render. */
  const cards = new Set<string>();
  const failed = new Set<string>();
  const peerEntry = (u: NonNullable<ReturnType<typeof userText>>, uuid: string, at: string): SessionEntry => {
    if (u.from && u.question) askers.set(u.question, u.from);
    return { uuid, at, role: "user", kind: u.kind, text: u.text, ...(u.from ? { peer: { dir: "in" as const, ticketId: u.from } } : {}) };
  };

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
    const at = typeof ev.timestamp === "string" ? ev.timestamp : "";
    const uuid = typeof ev.uuid === "string" ? ev.uuid : `${entries.length}`;
    // A message sent while Claude was working is saved as an attachment to the running turn, not a user message.
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && ev.attachment.commandMode === "prompt" && !ev.isSidechain) {
      const u = userText(ev.attachment.prompt);
      if (u) entries.push(peerEntry(u, uuid, at));
      continue;
    }
    if ((ev.type !== "user" && ev.type !== "assistant") || ev.isSidechain) continue;
    const content = ev.message?.content;

    if (ev.type === "user") {
      if (Array.isArray(content)) {
        for (const [i, b] of content.entries()) {
          if (b?.type === "tool_result" && b.is_error && cards.has(b.tool_use_id)) failed.add(b.tool_use_id);
          // The reply an ask_ticket call came back with: shown as that ticket's message.
          if (b?.type === "tool_result" && asks.has(b.tool_use_id) && !b.is_error) {
            const m = REPLY_HEAD.exec(resultText(b.content));
            if (m) {
              const text = resultText(b.content).slice(m[0].length).trim();
              entries.push({ uuid: i ? `${uuid}:${i}` : uuid, at, role: "user", kind: "text", text, peer: { dir: "in", ticketId: asks.get(b.tool_use_id) ?? m[1] } });
            }
          }
          // Only real publishes: output of the Artifact tool, or of the `ckanban artifact publish`
          // helper headless runs use. Other tools (e.g. Bash grepping a different session's file)
          // can print the same text.
          if (b?.type !== "tool_result" || !publishers.has(b.tool_use_id)) continue;
          for (const m of resultText(b.content).matchAll(PUBLISHED)) {
            const label = basename(m[1]).replace(/\.[a-z0-9]+$/i, "");
            artifacts.delete(m[2]); // re-insert so the newest publish sorts last
            artifacts.set(m[2], { url: m[2], label, at });
          }
        }
      }
      const u = userText(content);
      if (u && !ev.isMeta) entries.push(peerEntry(u, uuid, at));
      continue;
    }

    if (!Array.isArray(content)) continue;
    content.forEach((b: any, i: number) => {
      if (b?.type === "tool_use" && typeof b.id === "string" && isPublisher(b)) publishers.add(b.id);
      const id = i ? `${uuid}:${i}` : uuid;
      const card = b?.type === "tool_use" && typeof b.id === "string" ? cardEntry(b) : null;
      if (b?.type === "text" && b.text?.trim()) entries.push({ uuid: id, at, role: "assistant", kind: "text", ...assistantBlock(b.text.trim()) });
      else if (b?.type === "tool_use" && ASK_TOOL.test(b.name ?? "") && typeof b.input?.question === "string") {
        const to = typeof b.input.id === "string" ? b.input.id : null;
        if (typeof b.id === "string") asks.set(b.id, to);
        entries.push({ uuid: id, at, role: "assistant", kind: "text", text: b.input.question.trim(), peer: { dir: "out", ticketId: to } });
      } else if (b?.type === "tool_use" && REPLY_TOOL.test(b.name ?? "") && typeof b.input?.text === "string") {
        const to = typeof b.input.questionId === "string" ? askers.get(b.input.questionId) ?? null : null;
        entries.push({ uuid: id, at, role: "assistant", kind: "text", text: b.input.text.trim(), peer: { dir: "out", ticketId: to } });
      } else if (card) {
        // The tool_use id keeps the uuid stable, so form drafts and answered/applied state stick to it.
        cards.add(b.id);
        entries.push({ uuid: b.id, at, role: "assistant", kind: "text", text: "", ...card });
      } else if (b?.type === "tool_use") entries.push({ uuid: id, at, role: "assistant", kind: "tool", text: toolLabel(b) });
    });
  }

  if (failed.size) entries.splice(0, entries.length, ...entries.filter((e) => !failed.has(e.uuid)));
  const last = entries.findLast((e) => e.kind === "text" && (e.text || e.questions || e.proposal || e.newTickets));
  const lastText = !last ? "" : last.text
    || (last.questions ? `Asked ${last.questions.length} question${last.questions.length > 1 ? "s" : ""}`
      : last.newTickets ? `Proposed ${last.newTickets.length} new ticket${last.newTickets.length > 1 ? "s" : ""}` : "Proposed an updated ticket");
  return {
    title: customTitle ?? aiTitle,
    entries,
    artifacts: [...artifacts.values()],
    lastMessage: last ? { role: last.role, text: lastText, at: last.at } : null,
    ...pendingSince(entries),
  };
}

function pendingSince(entries: SessionEntry[]): Pick<ParsedSession, "openQuestions" | "pendingProposal" | "pendingNewTickets"> {
  let lastUser = -1;
  entries.forEach((e, i) => {
    // Messages from other tickets don't answer what Claude asked the user.
    if (e.role === "user" && e.kind === "text" && !e.peer) lastUser = i;
  });
  const after = entries.slice(lastUser + 1);
  return {
    openQuestions: after.reduce((n, e) => n + (e.questions?.length ?? 0), 0),
    pendingProposal: after.findLast((e) => e.proposal)?.proposal ?? null,
    pendingNewTickets: after.findLast((e) => e.newTickets)?.newTickets ?? [],
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
      openQuestions: p.openQuestions, pendingProposal: p.pendingProposal, pendingNewTickets: p.pendingNewTickets,
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
