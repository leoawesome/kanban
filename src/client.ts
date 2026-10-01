// Talks to the local daemon's HTTP API for the `ckanban ticket` CLI and the `ckanban mcp` server.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { defaultRoot, Store } from "./server/store";
import { STATUSES, type Status, type TicketMode } from "./server/types";

export class ClientError extends Error {}

export const DAEMON_DOWN = "ckanban daemon not running, run `ckanban install` or `ckanban dev`";

/** Set on every board run's claude process ("<profile>/<ticket id>"). */
export const RUN_ENV = "CKANBAN_TICKET";

export function boardPort(): number {
  return Number(process.env.CKANBAN_PORT) || new Store(defaultRoot()).config().port;
}

export interface ProfileInfo {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  running?: number;
}

export interface TicketInfo {
  id: string;
  title: string;
  status: Status;
  mode?: TicketMode;
  body: string;
  running?: boolean;
  outcome: string | null;
  prUrl: string | null;
  branch: string | null;
  lastActivity: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  attention?: { kind: string } | null;
}

export interface CommentInfo {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface TicketPatch {
  title?: string;
  body?: string;
  status?: Status;
  mode?: TicketMode;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class BoardClient {
  private base: string;

  constructor(port = boardPort(), private fetchFn: Fetch = fetch) {
    // 127.0.0.1, not localhost: the daemon only listens on IPv4 and checks the Host header.
    this.base = `http://127.0.0.1:${port}`;
  }

  get url(): string {
    return this.base;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ClientError(DAEMON_DOWN);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new ClientError(data?.error ?? `${method} ${path} failed: ${res.status}`);
    return data as T;
  }

  private t(slug: string, id?: string): string {
    const base = `/api/profiles/${encodeURIComponent(slug)}/tickets`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }

  listProfiles = () => this.req<ProfileInfo[]>("GET", "/api/profiles");
  listTickets = (slug: string) => this.req<TicketInfo[]>("GET", this.t(slug));
  getTicket = (slug: string, id: string) => this.req<TicketInfo>("GET", this.t(slug, id));
  createTicket = (slug: string, input: { title: string; body?: string; status?: Status; mode?: TicketMode }) =>
    this.req<TicketInfo>("POST", this.t(slug), input);
  updateTicket = (slug: string, id: string, patch: TicketPatch) => this.req<TicketInfo>("PATCH", this.t(slug, id), patch);
  deleteTicket = (slug: string, id: string) => this.req<void>("DELETE", this.t(slug, id));
  chat = (slug: string, id: string, text: string) => this.req<TicketInfo>("POST", `${this.t(slug, id)}/chat`, { text });
  stop = (slug: string, id: string) => this.req<{ stopped: boolean }>("POST", `${this.t(slug, id)}/stop`, {});
  listComments = (slug: string, id: string) => this.req<CommentInfo[]>("GET", `${this.t(slug, id)}/comments`);
  comment = (slug: string, id: string, text: string) => this.req<CommentInfo>("POST", `${this.t(slug, id)}/comments`, { text });
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Main checkout of the git repo `dir` is in (differs from `dir` inside a worktree), or null. */
export function mainCheckout(dir: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    const common = r.stdout.toString().trim();
    if (!common || !isAbsolute(common)) return null;
    return real(dirname(common));
  } catch {
    return null;
  }
}

/** The profile with the deepest `path` containing `dir`, or null. */
export function deepestProfile<P extends { path: string }>(profiles: P[], dir: string): P | null {
  let best: P | null = null;
  let bestLen = -1;
  for (const p of profiles) {
    const path = real(p.path);
    if (contains(path, dir) && path.length > bestLen) {
      best = p;
      bestLen = path.length;
    }
  }
  return best;
}

export function profileList(profiles: ProfileInfo[]): string {
  if (!profiles.length) return "No profiles yet; add one on the board first.";
  return "Profiles:\n" + profiles.map((p) => `  ${p.slug}  (${p.name}, ${p.path})`).join("\n");
}

/**
 * Picks the board to act on: an explicit slug (or name), else the profile whose folder contains
 * `cwd` (worktrees count as their main checkout), else fails listing the profiles.
 */
export function resolveProfile(
  profiles: ProfileInfo[], opts: { explicit?: string | null; cwd: string; main?: (dir: string) => string | null },
): ProfileInfo {
  const want = opts.explicit?.trim();
  if (want) {
    const p = profiles.find((x) => x.slug === want) ?? profiles.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (!p) throw new ClientError(`no profile "${want}". ${profileList(profiles)}`);
    return p;
  }
  const cwd = real(opts.cwd);
  const hit = deepestProfile(profiles, cwd);
  if (hit) return hit;
  const main = (opts.main ?? mainCheckout)(cwd);
  const viaMain = main && main !== cwd ? deepestProfile(profiles, main) : null;
  if (viaMain) return viaMain;
  throw new ClientError(`no profile matches ${cwd}; pass a profile. ${profileList(profiles)}`);
}

/** Profile the current board run belongs to, from CKANBAN_TICKET. */
export function runProfile(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[RUN_ENV];
  return v ? v.split("/")[0] || null : null;
}

/** Board runs may read the board but not change it, so a run can't create or start other runs. */
export function assertCanChange(env: Record<string, string | undefined> = process.env): void {
  if (env[RUN_ENV]) {
    throw new ClientError(
      `changing the board is disabled inside a board run (${RUN_ENV}=${env[RUN_ENV]}), so runs can't create or start other runs. ` +
      "Reading tickets still works; ask the user to make this change on the board.",
    );
  }
}

export function parseStatus(s: unknown): Status {
  const v = String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((STATUSES as string[]).includes(v)) return v as Status;
  throw new ClientError(`invalid status "${s}"; use one of: ${STATUSES.join(", ")}`);
}

export function parseMode(s: unknown): TicketMode {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "interview" || v === "auto") return v;
  throw new ClientError(`invalid mode "${s}"; use interview or auto`);
}

function state(t: TicketInfo): string {
  const bits: string[] = [t.status];
  if (t.running) bits.push("running");
  else if (t.outcome) bits.push(t.outcome);
  if (t.attention?.kind && !t.running) bits.push(`waiting: ${t.attention.kind}`);
  return bits.join(", ");
}

export function ticketLine(t: TicketInfo): string {
  return `${t.id}  [${state(t)}]  ${t.title}`;
}

export function ticketText(t: TicketInfo, comments: CommentInfo[] = []): string {
  const lines = [
    `${t.title}`,
    `id: ${t.id}`,
    `status: ${state(t)}`,
    `mode: ${t.mode ?? "auto"}`,
  ];
  if (t.branch) lines.push(`branch: ${t.branch}`);
  if (t.prUrl) lines.push(`pr: ${t.prUrl}`);
  if (t.lastActivity) lines.push(`activity: ${t.lastActivity}`);
  if (t.error) lines.push(`error: ${t.error}`);
  lines.push("", t.body.trim() || "(no description)");
  if (comments.length) {
    lines.push("", "Comments:");
    for (const c of comments) lines.push(`- ${c.author} (${c.at}): ${c.text}`);
  }
  return lines.join("\n");
}
