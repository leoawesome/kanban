export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";
export type Outcome = null | "done" | "blocked" | "failed" | "stopped";

export const COLUMNS: { id: Status; label: string; hint: string }[] = [
  { id: "backlog", label: "Backlog", hint: "Ideas" },
  { id: "planning", label: "Planning", hint: "Refine with Claude in terminal" },
  { id: "ready", label: "Ready", hint: "Claude picks these up" },
  { id: "in_progress", label: "In Progress", hint: "Claude working" },
  { id: "review", label: "Review", hint: "Your turn" },
  { id: "done", label: "Done", hint: "" },
];

export interface Profile {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  maxParallel: number;
  model?: string | null;
  createdAt: string;
  pathExists?: boolean;
  running?: number;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  order: number;
  sessionId: string | null;
  worktree: string | null;
  workdir?: string | null;
  branch: string | null;
  prUrl: string | null;
  outcome: Outcome;
  lastActivity: string | null;
  lastRunAt: string | null;
  runCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
  running?: boolean;
  resumeCommand?: string | null;
}

export interface Comment {
  id: string;
  author: "user" | "ai";
  text: string;
  at: string;
}

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}

export interface ClaudeProject {
  path: string;
  name: string;
  lastUsed: string | null;
  hasProfile: boolean;
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  lastActive: string;
  live: boolean;
  ticket: { id: string; title: string } | null;
}

export type BusEvent =
  | { type: "ticket.updated"; profile: string; ticket: Ticket }
  | { type: "ticket.deleted"; profile: string; id: string }
  | { type: "activity"; profile: string; id: string; run: number; event: any }
  | { type: "profile.updated"; slug: string; profile: Profile | null };

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const hasBody = method === "POST" || method === "PATCH";
  const r = await fetch(url, {
    method,
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any).error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

const t = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/tickets${id ? `/${encodeURIComponent(id)}` : ""}`;

export const api = {
  claudeProjects: () => req<ClaudeProject[]>("GET", "/api/claude/projects"),
  claudeDefaults: () => req<{ model: string | null }>("GET", "/api/claude/defaults"),
  pickFolder: () => req<{ path: string | null }>("POST", "/api/pick-folder"),
  health: () => req<{ claude: boolean; git: boolean; gh: boolean }>("GET", "/api/health"),
  profiles: () => req<Profile[]>("GET", "/api/profiles"),
  createProfile: (p: { name: string; path: string; maxParallel?: number; model?: string; baseBranch?: string }) =>
    req<Profile>("POST", "/api/profiles", p),
  updateProfile: (slug: string, p: Partial<Profile>) => req<Profile>("PATCH", `/api/profiles/${slug}`, p),
  deleteProfile: (slug: string) => req<void>("DELETE", `/api/profiles/${slug}`),
  tickets: (slug: string) => req<Ticket[]>("GET", t(slug)),
  ticket: (slug: string, id: string) => req<Ticket>("GET", t(slug, id)),
  sessions: (slug: string) => req<ClaudeSession[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/sessions`),
  linkSession: (slug: string, id: string, sessionId: string | null) =>
    req<Ticket>("POST", `${t(slug, id)}/link-session`, { sessionId }),
  createTicket: (slug: string, input: { title: string; body: string; status: Status; sessionId?: string }) =>
    req<Ticket>("POST", t(slug), input),
  updateTicket: (slug: string, id: string, patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order">> & { expectedBody?: string }) =>
    req<Ticket>("PATCH", t(slug, id), patch),
  deleteTicket: (slug: string, id: string) => req<void>("DELETE", t(slug, id)),
  comments: (slug: string, id: string) => req<Comment[]>("GET", `${t(slug, id)}/comments`),
  addComment: (slug: string, id: string, text: string) => req<Comment>("POST", `${t(slug, id)}/comments`, { text }),
  activity: (slug: string, id: string) => req<ActivityEntry[]>("GET", `${t(slug, id)}/activity`),
  stop: (slug: string, id: string) => req<{ stopped: boolean }>("POST", `${t(slug, id)}/stop`),
  checkPr: (slug: string, id: string) => req<{ state: string | null }>("POST", `${t(slug, id)}/check-pr`),
  planningCommand: (slug: string, id: string) => req<{ command: string }>("POST", `${t(slug, id)}/planning-command`),
};

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource("/api/events");
    source.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as BusEvent;
        for (const l of listeners) l(e);
      } catch {}
    };
  }
  return () => listeners.delete(fn);
}

/** Only allow https links from untrusted data (e.g. PR URLs reported by Claude). */
export function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https:\/\//.test(url) ? url : undefined;
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
