import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { ActivityEntry, Comment, Config, Profile, Status, Ticket } from "./types";
import { newId, newTicketId, nowIso } from "./util";

const DEFAULT_CONFIG: Config = { port: 7777, prPollMinutes: 5 };

export function defaultRoot(): string {
  return process.env.CKANBAN_HOME ?? join(homedir(), ".claude-kanban");
}

function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function parseTicket(raw: string): Ticket {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = YAML.parse(m[1]);
  if (!meta || typeof meta !== "object" || !meta.id) throw new Error("invalid frontmatter");
  return { ...meta, body: m[2] ?? "" } as Ticket;
}

function serializeTicket(t: Ticket): string {
  const { body, ...meta } = t;
  return `---\n${YAML.stringify(meta)}---\n${body}`;
}

export class Store {
  constructor(public readonly root: string) {
    mkdirSync(join(root, "profiles"), { recursive: true });
  }

  config(): Config {
    const file = join(this.root, "config.json");
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private profileDir(slug: string) {
    return join(this.root, "profiles", slug);
  }

  private ticketDir(slug: string, id: string) {
    return join(this.profileDir(slug), "tickets", id);
  }

  listProfiles(): Profile[] {
    const dir = join(this.root, "profiles");
    return readdirSync(dir)
      .map((s) => this.getProfile(s))
      .filter((p): p is Profile => p !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getProfile(slug: string): Profile | null {
    const file = join(this.profileDir(slug), "profile.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveProfile(p: Profile): void {
    atomicWrite(join(this.profileDir(p.slug), "profile.json"), JSON.stringify(p, null, 2) + "\n");
  }

  deleteProfile(slug: string): void {
    rmSync(this.profileDir(slug), { recursive: true, force: true });
  }

  ticketPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "ticket.md");
  }

  listTickets(slug: string): Ticket[] {
    const dir = join(this.profileDir(slug), "tickets");
    if (!existsSync(dir)) return [];
    const out: Ticket[] = [];
    for (const id of readdirSync(dir)) {
      if (!existsSync(this.ticketPath(slug, id))) continue;
      out.push(this.readTicketOrCorrupt(slug, id));
    }
    return out.sort((a, b) => a.order - b.order);
  }

  private readTicketOrCorrupt(slug: string, id: string): Ticket {
    const file = this.ticketPath(slug, id);
    try {
      return parseTicket(readFileSync(file, "utf8"));
    } catch (e) {
      const at = nowIso();
      return {
        id, title: id, status: "backlog", order: 0, sessionId: null, worktree: null, branch: null,
        prUrl: null, outcome: null, lastActivity: null, lastRunAt: null, runCount: 0,
        error: `corrupt ticket file: ${(e as Error).message}`, createdAt: at, updatedAt: at, body: "",
      };
    }
  }

  getTicket(slug: string, id: string): Ticket | null {
    if (!existsSync(this.ticketPath(slug, id))) return null;
    return this.readTicketOrCorrupt(slug, id);
  }

  nextOrder(slug: string, status: Status): number {
    const orders = this.listTickets(slug).filter((t) => t.status === status).map((t) => t.order);
    return orders.length ? Math.max(...orders) + 1 : 1;
  }

  createTicket(slug: string, input: { title: string; body: string; status: Status }): Ticket {
    const at = nowIso();
    const t: Ticket = {
      id: newTicketId(), title: input.title, status: input.status, order: this.nextOrder(slug, input.status),
      sessionId: null, worktree: null, branch: null, prUrl: null, outcome: null, lastActivity: null,
      lastRunAt: null, runCount: 0, error: null, createdAt: at, updatedAt: at, body: input.body,
    };
    atomicWrite(this.ticketPath(slug, t.id), serializeTicket(t));
    return t;
  }

  updateTicket(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    const current = parseTicket(readFileSync(this.ticketPath(slug, id), "utf8"));
    const next: Ticket = { ...current, ...patch, id, updatedAt: nowIso() };
    if (patch.body === undefined) next.body = current.body;
    atomicWrite(this.ticketPath(slug, id), serializeTicket(next));
    return next;
  }

  deleteTicket(slug: string, id: string): void {
    rmSync(this.ticketDir(slug, id), { recursive: true, force: true });
  }

  listComments(slug: string, id: string): Comment[] {
    return readJsonl<Comment>(join(this.ticketDir(slug, id), "comments.jsonl"));
  }

  addComment(slug: string, id: string, author: Comment["author"], text: string): Comment {
    const c: Comment = { id: newId(), author, text, at: nowIso() };
    appendFileSync(join(this.ticketDir(slug, id), "comments.jsonl"), JSON.stringify(c) + "\n");
    return c;
  }

  appendActivity(slug: string, id: string, run: number, event: unknown): void {
    const e: ActivityEntry = { run, at: nowIso(), event };
    appendFileSync(join(this.ticketDir(slug, id), "activity.jsonl"), JSON.stringify(e) + "\n");
  }

  readActivity(slug: string, id: string): ActivityEntry[] {
    return readJsonl<ActivityEntry>(join(this.ticketDir(slug, id), "activity.jsonl"));
  }
}
