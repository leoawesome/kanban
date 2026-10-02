import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { ConflictError, type Board } from "./board";
import { claudeDefaults, listClaudeProjects, listSessions, liveSessionMatch, pickFolder, processCommands } from "./claude";
import type { Bus, BusEvent } from "./events";
import { detectBaseBranch, isGitRepo, resolveBaseBranch, which } from "./git";
import { checkPr } from "./prpoller";
import { resumeCommand } from "./prompts";
import { cronError, describeCron, nextRuns, parseCron } from "./cron";
import { RUN_HEADER, ScheduleError, Scheduler } from "./scheduler";
import { attentionFor } from "./attention";
import { MAX_RETRIES, planActive } from "./plan";
import { BugReportError, draftReport, submitReport, type BugBlockId, type BugSource, type GhRunner } from "./bugreport";
import { AttachmentError, attachmentFile, attachmentType, IMAGE_TYPES, saveAttachment } from "./attachments";
import { FileError, listDir, openWithSystem, readFileForView } from "./files";
import { McpError, McpManager } from "./mcp";
import { AGENT_IDS, AgentError, AgentRegistry, type AgentId } from "./agents";
import { SessionCache } from "./session";
import { ptySupported, ShellManager, type PtyKind, type Shell } from "./shell";
import type { TerminalWatcher } from "./terminals";
import { UpdateChecker } from "./update";
import type { Store } from "./store";
import { STATUSES, type Profile, type ScheduleEditor, type Status, type Ticket } from "./types";
import { nowIso, slugify } from "./util";

export interface ServerDeps {
  store: Store;
  bus: Bus;
  board: Board;
  port: number;
  webDir: string;
  /** URL path → embedded file (standalone binary). When non-empty, used instead of webDir. */
  assets?: Record<string, string>;
  sessions?: SessionCache;
  updates?: UpdateChecker;
  terminals?: TerminalWatcher;
  shells?: ShellManager;
  mcp?: McpManager;
  scheduler?: Scheduler;
  agents?: AgentRegistry;
  /** Runs `gh` for bug reports (tests pass a fake). */
  gh?: GhRunner;
}

interface ShellSocket {
  kind: PtyKind;
  slug: string;
  /** Profile display name (the quick chat tells Claude which board it is on). */
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: Shell;
  unsubscribe?: () => void;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_MAX_PARALLEL = 5;
const INBOX_KINDS = new Set(["questions", "proposal", "reply", "blocked", "failed"]);
/** Output extensions served with their image type (raster only) so the Outputs tab can preview them. */
const OUTPUT_IMAGE_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  jpeg: "image/jpeg",
};

export function isAllowedRequest(req: Request, port: number): boolean {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOCAL_HOSTS.some((h) => host === `${h}:${port}`)) return false;
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && req.method !== "HEAD" && origin) {
    if (!LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`)) return false;
  }
  return true;
}

/** WebSocket upgrades are GETs, so they need their own Origin check (browsers always send one). */
export function isAllowedSocket(req: Request, port: number): boolean {
  const origin = req.headers.get("origin");
  return isAllowedRequest(req, port) && !!origin && LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function createServer(deps: ServerDeps) {
  const { store, bus, board } = deps;
  const sessions = deps.sessions ?? new SessionCache();
  const updates = deps.updates ?? new UpdateChecker();
  const shells = deps.shells ?? new ShellManager();
  const mcp = deps.mcp ?? new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const scheduler = deps.scheduler ?? new Scheduler(board, store, bus);
  const agents = deps.agents ?? new AgentRegistry();

  const profileOr404 = (slug: string): Profile => {
    const p = store.getProfile(slug);
    if (!p) throw new HttpError(404, `profile ${slug} not found`);
    return p;
  };
  const ticketOr404 = (slug: string, id: string): Ticket => {
    const t = store.getTicket(slug, id);
    if (!t) throw new HttpError(404, `ticket ${id} not found`);
    return t;
  };
  // Only read when a planner has proposed tickets, so listing the board stays cheap.
  const childTitles = (slug: string, id: string) =>
    new Set(store.listTickets(slug).filter((c) => c.parentId === id).map((c) => c.title));
  /**
   * Board runs send RUN_HEADER ("<profile>/<ticket id>") with ticket changes. Runs can't change the board,
   * except a running plan's planner on its own child tickets. Returns that planner, or undefined for the user.
   */
  const plannerFor = (req: Request, slug: string, target?: Ticket): Ticket | undefined => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return undefined;
    const [runSlug, runId] = h.split("/");
    const planner = runSlug === slug && runId ? board.activePlanner(slug, runId) : null;
    if (!planner) {
      throw new HttpError(403, "changing the board is disabled inside a board run, so runs can't create or start other runs; " +
        "only the planner of a running plan may change its own child tickets");
    }
    if (target && target.parentId !== planner.id) {
      throw new HttpError(403, `${target.id} is not a child ticket of plan ${planner.id}; the planner may only change its own child tickets`);
    }
    return planner;
  };
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined;
  const view = (p: Profile, t: Ticket) => {
    const running = board.isRunning(p.slug, t.id);
    const session = t.sessionId ? sessions.summary(t.sessionId) : null;
    return {
      ...t,
      running,
      resumeCommand: t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? p.path, t.sessionId) : null,
      session,
      /** Linked session is open in a terminal right now (board chat still works, UI warns). */
      terminalOpen: deps.terminals?.isOpen(p.slug, t.id) ?? false,
      attention: attentionFor(t, session, running, {
        createdTitles: session?.pendingNewTickets.length ? childTitles(p.slug, t.id) : undefined,
        managed: t.parentId ? planActive(store.getTicket(p.slug, t.parentId)?.plan) : false,
      }),
    };
  };

  async function api(req: Request, url: URL): Promise<Response | undefined> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const m = req.method;
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    // Image uploads send the raw bytes. image/* types are not CORS-safelisted, so they preflight like JSON does.
    if (parts[0] === "attachments") {
      if (m === "POST" && parts.length === 1) {
        if (!IMAGE_TYPES[type]) throw new HttpError(415, "only PNG, JPEG, GIF and WebP images are supported");
        try {
          const name = saveAttachment(store.attachmentsDir, type, new Uint8Array(await req.arrayBuffer()));
          return json({ url: `/api/attachments/${name}`, path: join(store.attachmentsDir, name) }, 201);
        } catch (e) {
          if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }
      if (m === "GET" && parts.length === 2) {
        const file = attachmentFile(store.attachmentsDir, parts[1]);
        if (!file) throw new HttpError(404, "attachment not found");
        return new Response(Bun.file(file), {
          headers: {
            "content-type": attachmentType(parts[1])!,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
      }
      throw new HttpError(404, "not found");
    }

    // Only JSON mutations: blocks HTML <form> posts (text/plain, urlencoded) that skip CORS preflight.
    if ((m === "POST" || m === "PATCH" || m === "PUT") && type !== "application/json") {
      throw new HttpError(415, "content-type must be application/json");
    }

    if (parts[0] === "health" && m === "GET") {
      const [claude, git, gh] = await Promise.all([
        which(process.env.CKANBAN_CLAUDE_BIN ?? "claude"), which("git"), which("gh"),
      ]);
      return json({ claude, git, gh, pty: ptySupported() });
    }

    if (parts[0] === "events" && m === "GET") return sse(req);
    if (parts[0] === "version" && m === "GET") return json(await updates.status());
    if (parts[0] === "inbox" && m === "GET") {
      // Every board: tickets where Claude is waiting on the user (Review is left out on purpose).
      const out = [];
      for (const p of store.listProfiles()) {
        for (const t of store.listTickets(p.slug)) {
          const att = view(p, t).attention;
          if (att && INBOX_KINDS.has(att.kind)) out.push({ profile: p.slug, profileName: p.name, id: t.id, title: t.title, attention: att });
        }
      }
      return json(out);
    }

    // Connections panel: Claude Code MCP servers (always from the home dir, user scope for edits).
    if (parts[0] === "mcp") {
      const name = parts[1];
      if (parts.length === 1 && m === "GET") return json(mcp.state());
      if (parts.length === 1 && m === "POST") {
        await mcp.add(await body(req));
        return json(mcp.state(), 201);
      }
      if (parts.length === 2 && name === "refresh" && m === "POST") {
        mcp.refresh();
        return json(mcp.state(), 202);
      }
      if (parts.length === 2 && m === "DELETE") {
        await mcp.remove(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "login") {
        mcp.login(name);
        return json(mcp.state(), 202);
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "cancel-login") {
        mcp.cancelLogin(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "logout") {
        await mcp.logout(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "recheck") {
        const s = await mcp.recheck(name);
        if (!s) throw new HttpError(502, `couldn't check ${name}; try Refresh`);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "GET" && parts[2] === "config") return json(mcp.config(name));
      if (parts.length === 2 && m === "PUT") {
        await mcp.update(name, await body(req));
        return json(mcp.state());
      }
      throw new HttpError(404, "not found");
    }

    // Connections panel: is `ckanban mcp` registered with Claude Code / Codex, and (un)register it.
    if (parts[0] === "agents") {
      if (parts.length === 1 && m === "GET") return json(await agents.status());
      const id = parts[1] as AgentId;
      if (parts.length === 3 && m === "POST" && AGENT_IDS.includes(id) && (parts[2] === "install" || parts[2] === "uninstall")) {
        await (parts[2] === "install" ? agents.install(id) : agents.uninstall(id));
        if (id === "claude") mcp.refresh();
        return json(await agents.status());
      }
      throw new HttpError(404, "not found");
    }

    // Schedule form preview: is the expression valid, what it means, when it fires next.
    if (parts[0] === "cron" && parts[1] === "preview" && parts.length === 2 && m === "GET") {
      const expr = (url.searchParams.get("expr") ?? "").trim();
      const error = expr ? cronError(expr) : "cron expression is required";
      if (error) return json({ valid: false, error, summary: null, next: [] });
      return json({ valid: true, error: null, summary: describeCron(expr), next: nextRuns(parseCron(expr), new Date(), 3).map((d) => d.toISOString()) });
    }

    if (parts[0] === "claude" && parts[1] === "projects" && m === "GET") {
      const taken = new Set(store.listProfiles().map((p) => p.path));
      return json(listClaudeProjects().map((p) => ({ ...p, hasProfile: taken.has(p.path) })));
    }
    if (parts[0] === "claude" && parts[1] === "defaults" && m === "GET") return json(claudeDefaults());
    if (parts[0] === "pick-folder" && m === "POST") return json({ path: await pickFolder() });

    // Report bug: context preview, then file a GitHub issue on the ckanban repo.
    if (parts[0] === "bug-report" && m === "POST" && parts.length <= 2) {
      const b = await body(req);
      const ref = b.ticketId ? { slug: String(b.profile ?? ""), id: String(b.ticketId) } : null;
      try {
        const draft = draftReport(store, ref);
        if (parts[1] === "draft") return json(draft);
        if (parts.length !== 1) throw new HttpError(404, "not found");
        const source: BugSource = b.source === "ai" || b.source === "cli" ? b.source : "ui";
        const include = Array.isArray(b.include) ? (b.include.map(String) as BugBlockId[]) : undefined;
        const r = await submitReport(
          { title: String(b.title ?? ""), description: String(b.description ?? ""), blocks: draft.blocks, include, source },
          { dataRoot: store.root, gh: deps.gh },
        );
        return json(r, r.url ? 201 : 200);
      } catch (e) {
        if (e instanceof BugReportError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    if (parts[0] !== "profiles") throw new HttpError(404, "not found");

    // /profiles
    if (parts.length === 1) {
      if (m === "GET") {
        return json(store.listProfiles().map((p) => ({ ...p, pathExists: existsSync(p.path), running: board.running(p.slug) })));
      }
      if (m === "POST") {
        const b = await body(req);
        const name = String(b.name ?? "").trim();
        const path = String(b.path ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!name) throw new HttpError(400, "name is required");
        if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `path is not a directory: ${path}`);
        let slug = slugify(name);
        for (let i = 2; store.getProfile(slug); i++) slug = `${slugify(name)}-${i}`;
        const profile: Profile = {
          name, slug, path,
          // Empty when there is nothing to branch from yet (not a repo, or no commits); runs re-detect it.
          baseBranch: b.baseBranch || ((await isGitRepo(path)) ? (await resolveBaseBranch(path, await detectBaseBranch(path))) ?? "" : ""),
          maxParallel: Math.max(1, Number(b.maxParallel) || DEFAULT_MAX_PARALLEL),
          model: b.model || null,
          createdAt: nowIso(),
        };
        store.saveProfile(profile);
        bus.emit({ type: "profile.updated", slug, profile });
        return json(profile, 201);
      }
    }

    const slug = parts[1];
    const profile = profileOr404(slug);

    // /profiles/:p
    if (parts.length === 2) {
      if (m === "GET") return json(profile);
      if (m === "PATCH") {
        const b = await body(req);
        const next: Profile = { ...profile };
        if (b.name !== undefined) next.name = String(b.name);
        if (b.path !== undefined) next.path = String(b.path);
        if (b.baseBranch !== undefined) next.baseBranch = String(b.baseBranch);
        if (b.maxParallel !== undefined) next.maxParallel = Math.max(1, Number(b.maxParallel) || 1);
        if (b.model !== undefined) next.model = b.model || null;
        if (next.path !== profile.path) shells.kill(slug);
        store.saveProfile(next);
        bus.emit({ type: "profile.updated", slug, profile: next });
        board.dispatch(slug);
        return json(next);
      }
      if (m === "DELETE") {
        if (board.running(slug) > 0) throw new HttpError(409, "profile has running tickets");
        store.deleteProfile(slug);
        shells.kill(slug);
        bus.emit({ type: "profile.updated", slug, profile: null });
        return new Response(null, { status: 204 });
      }
    }

    // /profiles/:p/sessions — Claude Code sessions started in the profile folder
    if (parts[2] === "sessions" && parts.length === 3 && m === "GET") {
      const commands = await processCommands();
      const linked = new Map(store.listTickets(slug).filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));
      return json(listSessions(profile.path).map((s) => ({
        ...s,
        live: liveSessionMatch(commands, s),
        ticket: linked.has(s.id) ? { id: linked.get(s.id)!.id, title: linked.get(s.id)!.title } : null,
      })));
    }

    // /profiles/:p/files?path= (one directory level) and /profiles/:p/file?path= (read-only contents)
    if ((parts[2] === "files" || parts[2] === "file") && parts.length === 3 && m === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      try {
        if (parts[2] === "files") return json({ path: rel, entries: await listDir(profile.path, rel) });
        return json(readFileForView(profile.path, rel));
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // /profiles/:p/open-file { path } — open a file from the explorer in its default app
    if (parts[2] === "open-file" && parts.length === 3 && m === "POST") {
      const rel = String((await body(req)).path ?? "");
      try {
        openWithSystem(profile.path, rel, process.env.CKANBAN_OPEN_BIN);
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return json({ ok: true });
    }

    // /profiles/:p/shell — WebSocket to the profile's interactive shell
    if (parts[2] === "shell" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port)) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { kind: "shell", slug, name: profile.name, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if (server.upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/claude — WebSocket to the dock's quick Claude chat (interactive `claude` in the profile folder)
    if (parts[2] === "claude" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port)) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { kind: "claude", slug, name: profile.name, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if (server.upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/claude/session — which Claude session the quick chat runs, and whether it has messages yet
    if (parts[2] === "claude" && parts[3] === "session" && parts.length === 4 && m === "GET") {
      const pty = shells.current(slug, "claude");
      const id = pty?.sessionId ?? null;
      const summary = id ? sessions.summary(id) : null;
      return json({ sessionId: id, running: !!pty && !pty.exited, started: !!summary, title: summary?.title ?? null });
    }

    // /profiles/:p/schedules — recurring ticket templates
    if (parts[2] === "schedules") {
      // Set by the ckanban MCP tools inside a board run ("<profile>/<ticket id>"): the edit is credited to that ticket.
      const run = req.headers.get(RUN_HEADER)?.split("/")[1] ?? "";
      const by: ScheduleEditor = /^t_[a-z0-9_]+$/i.test(run) ? { ticketId: run } : "user";
      if (parts.length === 3 && m === "GET") return json(store.listSchedules(slug).map((s) => scheduler.view(slug, s)));
      if (parts.length === 3 && m === "POST") return json(scheduler.view(slug, scheduler.create(slug, (await body(req)) ?? {}, by)), 201);
      const sid = parts[3];
      if (parts.length === 4 && m === "PATCH") return json(scheduler.view(slug, scheduler.update(slug, sid, (await body(req)) ?? {}, by)));
      if (parts.length === 4 && m === "DELETE") {
        scheduler.remove(slug, sid, by);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 5 && parts[4] === "history" && m === "GET") return json(scheduler.history(slug, sid));
      if (parts.length === 5 && parts[4] === "run" && m === "POST") {
        const entry = await scheduler.runNow(slug, sid);
        return json({ entry, schedule: scheduler.view(slug, scheduler.get(slug, sid)) });
      }
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/tickets
    if (parts[2] !== "tickets") throw new HttpError(404, "not found");
    if (parts.length === 3) {
      if (m === "GET") return json(store.listTickets(slug).map((t) => view(profile, t)));
      if (m === "POST") {
        const b = await body(req);
        const title = String(b.title ?? "").trim();
        if (!title) throw new HttpError(400, "title is required");
        const planner = plannerFor(req, slug);
        let status: Status = STATUSES.includes(b.status) ? b.status : "backlog";
        let mode: "auto" | "interview" = b.mode === "auto" ? "auto" : "interview";
        let parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : undefined;
        const planKey = typeof b.planKey === "string" && b.planKey.trim() ? b.planKey.trim() : undefined;
        const dependsOn = strings(b.dependsOn);
        if (planner) {
          // A planner adds children to its own plan; the board starts them when their dependencies are done.
          const kids = store.listTickets(slug).filter((c) => c.parentId === planner.id);
          const cap = 2 * Math.max(1, planner.plan!.originalCount);
          if (kids.length >= cap) throw new HttpError(409, `child ticket limit reached (${cap}) for this plan`);
          const missing = (dependsOn ?? []).filter((d) => !kids.some((k) => k.id === d || k.planKey === d));
          if (missing.length) throw new HttpError(400, `unknown dependency ${missing.join(", ")}: use a sibling's ticket id or key`);
          [parentId, status, mode] = [planner.id, "backlog", "auto"];
        }
        if (parentId && !store.getTicket(slug, parentId)) throw new HttpError(400, `parent ticket ${parentId} not found`);
        let t = await board.createTicket(slug, {
          title, body: String(b.body ?? ""), status: b.sessionId && !planner ? "backlog" : status, mode, parentId, planKey, dependsOn,
        });
        if (planner) store.addComment(slug, t.id, "ai", `Created by the planner of plan ${planner.id}.`);
        if (b.sessionId && !planner) {
          try {
            await board.linkSession(slug, t.id, String(b.sessionId));
            t = await board.updateTicket(slug, t.id, { status });
          } catch (e) {
            await board.deleteTicket(slug, t.id);
            throw new HttpError(400, (e as Error).message);
          }
        }
        return json(view(profile, store.getTicket(slug, t.id)!), 201);
      }
    }

    const id = parts[3];
    ticketOr404(slug, id);

    if (parts.length === 4) {
      if (m === "GET") return json(view(profile, store.getTicket(slug, id)!));
      if (m === "PATCH") {
        const b = await body(req);
        if (b.status !== undefined && !STATUSES.includes(b.status)) throw new HttpError(400, `invalid status ${b.status}`);
        const target = store.getTicket(slug, id)!;
        const planner = plannerFor(req, slug, target);
        const patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "dependsOn">> & { expectedBody?: string } = {};
        const deps = strings(b.dependsOn);
        if (deps) patch.dependsOn = deps;
        if (b.mode === "auto" || b.mode === "interview") patch.mode = b.mode;
        if (typeof b.expectedBody === "string") patch.expectedBody = b.expectedBody;
        if (typeof b.title === "string") patch.title = b.title;
        if (typeof b.body === "string") patch.body = b.body;
        if (b.status) patch.status = b.status;
        if (typeof b.order === "number") patch.order = b.order;
        if (b.notice === null) patch.notice = null;
        if (planner) {
          delete patch.order;
          delete patch.notice;
          if (patch.status === "ready" && target.status !== "ready" && target.runCount > 0) {
            try {
              board.countRetry(slug, planner.id, id, MAX_RETRIES);
            } catch (e) {
              throw new HttpError(409, (e as Error).message);
            }
          }
        }
        let t: Ticket;
        try {
          t = await board.updateTicket(slug, id, patch);
        } catch (e) {
          if (e instanceof ConflictError) throw e;
          throw new HttpError(400, (e as Error).message);
        }
        if (planner) {
          const what = Object.entries(patch).map(([k, v]) => (k === "status" ? `moved it to ${v}` : `changed ${k}`)).join(", ");
          if (what) store.addComment(slug, id, "ai", `Planner ${what}.`);
        }
        return json(view(profile, t));
      }
      if (m === "DELETE") {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "deleting tickets is disabled inside a board run");
        await board.deleteTicket(slug, id);
        return new Response(null, { status: 204 });
      }
    }

    const action = parts[4];
    if (action === "activity" && m === "GET") return json(store.readActivity(slug, id));
    if (action === "outputs" && m === "GET") {
      if (parts.length === 5) return json(store.listOutputs(slug, id));
      const file = store.outputPath(slug, id, parts.slice(5).join("/"));
      if (!file) throw new HttpError(404, "output not found");
      // Plain text + sandbox: files are written by Claude and must never run as HTML on this origin.
      // Only raster images get their real type so the viewer can preview them; SVG stays text (it can carry scripts).
      const image = OUTPUT_IMAGE_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
      return new Response(Bun.file(file), {
        headers: {
          "content-type": image ?? "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
        },
      });
    }
    if (action === "conversation" && m === "GET") {
      // Read-only view of the ticket's Claude session file (terminal chat + board runs), newest last.
      const t = store.getTicket(slug, id)!;
      const parsed = t.sessionId ? sessions.get(t.sessionId) : null;
      const all = parsed?.entries ?? [];
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
      const end = Math.max(0, Math.min(all.length, before));
      const start = Math.max(0, end - limit);
      return json({ entries: all.slice(start, end), start, total: all.length, title: parsed?.title ?? null });
    }
    if (action === "comments") {
      if (m === "GET") return json(store.listComments(slug, id));
      if (m === "POST") {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "text is required");
        // The child reads user comments on its next run; mark who wrote this one.
        const planner = plannerFor(req, slug, store.getTicket(slug, id)!);
        return json(board.addComment(slug, id, planner ? `Planner: ${text}` : text), 201);
      }
    }
    if (m === "POST" && action === "chat") {
      plannerFor(req, slug, store.getTicket(slug, id)!);
      const b = await body(req);
      const text = String(b.text ?? "").trim();
      if (!text) throw new HttpError(400, "text is required");
      const t = await board.chat(slug, id, text);
      return json(view(profile, t), 202);
    }
    // A message Stop left unsent: POST .../queued/<msgId> sends it, DELETE discards it.
    if (action === "queued" && parts[5] && (m === "POST" || m === "DELETE")) {
      try {
        const t = m === "POST" ? await board.sendQueued(slug, id, parts[5]) : board.discardQueued(slug, id, parts[5]);
        return json(view(profile, t), m === "POST" ? 202 : 200);
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(404, (e as Error).message);
      }
    }
    if (m === "POST" && action === "link-session") {
      const b = await body(req);
      try {
        const t = await board.linkSession(slug, id, b.sessionId ? String(b.sessionId) : null);
        return json(view(profile, t));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (m === "POST" && action === "stop") {
      const planner = plannerFor(req, slug, store.getTicket(slug, id)!);
      const stopped = board.stop(slug, id);
      if (planner && stopped) store.addComment(slug, id, "ai", "Planner stopped this run.");
      return json({ stopped });
    }
    // Start / pause / resume a planner's plan, or change how many children run at once.
    if (m === "POST" && action === "plan") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can start or pause a plan");
      const b = await body(req);
      const n = b.maxConcurrent === undefined ? undefined : Number(b.maxConcurrent);
      try {
        const t = b.action === "pause" ? board.pausePlan(slug, id)
          : b.action === "start" || b.action === "resume" ? board.startPlan(slug, id, { maxConcurrent: n })
          : b.action === "concurrency" && n !== undefined ? board.setPlanConcurrency(slug, id, n)
          : null;
        if (!t) throw new HttpError(400, "action must be start, pause, resume or concurrency");
        return json(view(profile, store.getTicket(slug, id) ?? t));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (m === "POST" && action === "check-pr") {
      const state = await checkPr(board, store, slug, id);
      return json({ state, ticket: view(profile, store.getTicket(slug, id)!) });
    }
    if (m === "POST" && action === "planning-command") {
      try {
        return json({ command: await board.planningCommand(slug, id) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    throw new HttpError(404, "not found");
  }

  function sse(req: Request): Response {
    let unsubscribe = () => {};
    let ping: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {}
        };
        send(": connected\n\n");
        unsubscribe = bus.on((e: BusEvent) => {
          let out: unknown = e;
          if (e.type === "ticket.updated") {
            const p = store.getProfile(e.profile);
            if (p) out = { ...e, ticket: view(p, e.ticket) };
          }
          send(`data: ${JSON.stringify(out)}\n\n`);
          // Session changes (terminal chat, new questions) change the ticket's "your turn" state too.
          if (e.type === "session.updated") {
            const p = store.getProfile(e.profile);
            const t = p && store.getTicket(e.profile, e.id);
            if (p && t) send(`data: ${JSON.stringify({ type: "ticket.updated", profile: e.profile, ticket: view(p, t) })}\n\n`);
          }
        });
        ping = setInterval(() => send(": ping\n\n"), 15_000);
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(ping);
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        unsubscribe();
        clearInterval(ping);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  function staticFile(url: URL): Response {
    const assets = deps.assets ?? {};
    if (Object.keys(assets).length) {
      const hit = assets[url.pathname] ?? assets["/index.html"];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(Bun.file(hit));
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(deps.webDir, rel);
    if (file.startsWith(deps.webDir) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    const index = join(deps.webDir, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index));
    return new Response("UI not built. Run: bun run build:web", { status: 404 });
  }

  function attachShell(ws: import("bun").ServerWebSocket<ShellSocket>, restart = false, resumeChat = false) {
    const d = ws.data;
    d.unsubscribe?.();
    let shell: Shell;
    try {
      // An exited quick chat that has messages comes back on the same session ("Start again").
      const prev = shells.current(d.slug, d.kind);
      const resume = resumeChat && !!prev?.sessionId && sessions.version(prev.sessionId) !== null;
      shell = shells.get(d.slug, d.cwd, d.cols, d.rows, restart, d.kind, resume, d.name);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      return;
    }
    d.shell = shell;
    const back = shell.scrollback();
    if (back.length) ws.sendBinary(back);
    if (shell.exited) ws.send(JSON.stringify({ type: "exit", code: shell.exitCode }));
    else shell.resize(d.cols, d.rows);
    d.unsubscribe = shell.subscribe((e) => {
      if (e.type === "data") ws.sendBinary(e.data);
      else ws.send(JSON.stringify({ type: "exit", code: e.code }));
    });
  }

  const server = Bun.serve<ShellSocket>({
    hostname: "127.0.0.1",
    port: deps.port,
    idleTimeout: 0,
    async fetch(req) {
      if (!isAllowedRequest(req, server.port ?? deps.port)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return staticFile(url);
      try {
        return (await api(req, url)) as Response;
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        if (e instanceof ConflictError) return json({ error: e.message }, 409);
        if (e instanceof McpError) return json({ error: e.message }, e.status);
        if (e instanceof AgentError) return json({ error: e.message }, e.status);
        if (e instanceof ScheduleError) return json({ error: e.message }, e.status);
        if (e instanceof URIError) return json({ error: "malformed URL" }, 400);
        console.error(e);
        return json({ error: (e as Error).message ?? "internal error" }, 500);
      }
    },
    websocket: {
      open: (ws) => attachShell(ws),
      message(ws, raw) {
        let msg: any;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          return;
        }
        const shell = ws.data.shell;
        if (msg.type === "input" && typeof msg.data === "string") shell?.write(msg.data);
        else if (msg.type === "resize") {
          ws.data.cols = Math.min(1000, Math.max(1, Number(msg.cols) || 80));
          ws.data.rows = Math.min(1000, Math.max(1, Number(msg.rows) || 24));
          shell?.resize(ws.data.cols, ws.data.rows);
        } else if (msg.type === "restart") {
          // Another tab may already have restarted it: then just join the new shell.
          ws.send(JSON.stringify({ type: "reset" }));
          attachShell(ws, shells.current(ws.data.slug, ws.data.kind) === shell, msg.resume === true);
        }
      },
      close: (ws) => ws.data.unsubscribe?.(),
    },
  });
  return server;
}
