export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";
export type Outcome = null | "done" | "blocked" | "failed" | "stopped" | "needs_input";
export type TicketMode = "interview" | "auto";

/** claude: dropping a card here makes Claude start (or it is running). */
export const COLUMNS: { id: Status; label: string; hint: string; claude: boolean }[] = [
  { id: "backlog", label: "Backlog", hint: "Park ideas. Nothing runs.", claude: false },
  { id: "planning", label: "Planning", hint: "Claude interviews you and shapes the ticket", claude: true },
  { id: "ready", label: "Ready", hint: "Claude starts the work on its own", claude: true },
  { id: "in_progress", label: "In Progress", hint: "Claude is working", claude: true },
  { id: "review", label: "Review", hint: "Your turn: check the result", claude: false },
  { id: "done", label: "Done", hint: "Finished", claude: false },
];

export type AttentionKind = "failed" | "blocked" | "questions" | "proposal" | "review" | "reply";

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
  mode?: TicketMode;
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
  /** Linked session currently open in a terminal. */
  terminalOpen?: boolean;
  resumeCommand?: string | null;
  session?: SessionSummary | null;
  /** Why the ticket is waiting on you ("Your turn"), computed by the server. */
  attention?: { kind: AttentionKind; label: string } | null;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: { url: string; label: string; at: string }[];
  updatedAt: string;
  openQuestions: number;
  pendingProposal: { title: string; description: string } | null;
}

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

export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  kind: "text" | "tool" | "board";
  text: string;
  questions?: Question[];
  proposal?: { title: string; description: string };
  moved?: "planning";
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

export interface OutputFile {
  name: string;
  size: number;
  updatedAt: string;
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
  | { type: "profile.updated"; slug: string; profile: Profile | null }
  | { type: "session.updated"; profile: string; id: string; session: SessionSummary }
  | { type: "draft"; profile: string; id: string; text: string };

export interface InboxItem {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  attention: { kind: AttentionKind; label: string };
}

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
  version: () => req<{ version: string; latest: string | null; updateAvailable: boolean; url: string | null }>("GET", "/api/version"),
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
  outputs: (slug: string, id: string) => req<OutputFile[]>("GET", `${t(slug, id)}/outputs`),
  outputText: async (slug: string, id: string, name: string) => {
    const r = await fetch(`${t(slug, id)}/outputs/${name.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  },
  createTicket: (slug: string, input: { title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode }) =>
    req<Ticket>("POST", t(slug), input),
  updateTicket: (slug: string, id: string, patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode">> & { expectedBody?: string }) =>
    req<Ticket>("PATCH", t(slug, id), patch),
  deleteTicket: (slug: string, id: string) => req<void>("DELETE", t(slug, id)),
  comments: (slug: string, id: string) => req<Comment[]>("GET", `${t(slug, id)}/comments`),
  addComment: (slug: string, id: string, text: string) => req<Comment>("POST", `${t(slug, id)}/comments`, { text }),
  chat: (slug: string, id: string, text: string) => req<Ticket>("POST", `${t(slug, id)}/chat`, { text }),
  conversation: (slug: string, id: string, before?: number) =>
    req<{ entries: SessionEntry[]; start: number; total: number; title: string | null }>(
      "GET", `${t(slug, id)}/conversation${before !== undefined ? `?before=${before}` : ""}`),
  activity: (slug: string, id: string) => req<ActivityEntry[]>("GET", `${t(slug, id)}/activity`),
  inbox: () => req<InboxItem[]>("GET", "/api/inbox"),
  stop: (slug: string, id: string) => req<{ stopped: boolean }>("POST", `${t(slug, id)}/stop`),
  checkPr: (slug: string, id: string) => req<{ state: string | null }>("POST", `${t(slug, id)}/check-pr`),
  planningCommand: (slug: string, id: string) => req<{ command: string }>("POST", `${t(slug, id)}/planning-command`),
  /** Raw image bytes; the server saves them and returns the URL to put in markdown. */
  uploadImage: async (file: Blob) => {
    const r = await fetch("/api/attachments", { method: "POST", headers: { "content-type": file.type }, body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as any).error ?? `${r.status} ${r.statusText}`);
    return data as { url: string; path: string };
  },
};

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
let source: EventSource | null = null;
let lostConnection = false;

function connect() {
  source = new EventSource("/api/events");
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as BusEvent;
      for (const l of listeners) l(e);
    } catch {}
  };
  source.onerror = () => {
    // EventSource retries on its own; remember that we missed events meanwhile.
    lostConnection = true;
  };
  source.onopen = () => {
    if (!lostConnection) return;
    lostConnection = false;
    for (const fn of reconnectListeners) fn();
  };
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) connect();
  return () => listeners.delete(fn);
}

/** Called after the live connection comes back (daemon restart, laptop sleep): refetch state. */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  if (!source) connect();
  return () => reconnectListeners.delete(fn);
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
