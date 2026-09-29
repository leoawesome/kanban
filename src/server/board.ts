import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFinalText, summarizeEvent } from "./activity";
import type { Bus } from "./events";
import { isSessionLive as psSessionLive, sessionTitle } from "./claude";
import { addWorktree, isGitRepo, removeWorktree, worktreeDir } from "./git";
import { chatPrompt, firstRunPrompt, planningCommand, planningPrompt, resumePrompt, type ChatMode } from "./prompts";
import { parseResult } from "./result";
import { buildArgs, startRun, type RunHandle } from "./runner";
import type { Store } from "./store";
import type { Status, Ticket, TicketMode } from "./types";
import { nowIso, slugify } from "./util";

export interface BoardOptions {
  claudeBin: string;
  /** Whether Claude has a stored session with this id (used to pick --resume vs --session-id). */
  sessionExists?: (sessionId: string) => boolean;
  /** Whether an interactive claude process currently has this session open. */
  isSessionLive?: (sessionId: string, title: string | null) => Promise<boolean>;
}

interface ActiveRun {
  slug: string;
  id: string;
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Status to land on when the run ends because the user moved the card. */
  targetStatus: Status | null;
  stopRequested: boolean;
  /** Set for runs started from the ticket chat (not the Ready queue). */
  chat?: { text: string; mode: ChatMode };
}

/** Backlog/Planning chats refine the ticket (read-only); everywhere else Claude acts on the message. */
export function chatModeFor(status: Status): ChatMode {
  return status === "backlog" || status === "planning" ? "refine" : "act";
}

const ACTIVITY_THROTTLE_MS = 1000;

export function claudeSessionExists(sessionId: string): boolean {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root).some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

export class ConflictError extends Error {}

export class Board {
  private runs = new Map<string, ActiveRun>();
  private shuttingDown = false;
  private sessionExists: (id: string) => boolean;
  private isSessionLive: (id: string, title: string | null) => Promise<boolean>;

  constructor(private store: Store, private bus: Bus, private opts: BoardOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    this.isSessionLive = opts.isSessionLive ?? psSessionLive;
  }

  private key(slug: string, id: string) {
    return `${slug}/${id}`;
  }

  private emitTicket(slug: string, t: Ticket) {
    this.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  }

  private patch(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    const t = this.store.updateTicket(slug, id, patch);
    this.emitTicket(slug, t);
    return t;
  }

  /** Queue runs only: chat replies are interactive and don't take a maxParallel slot. */
  running(slug: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.slug === slug && !r.chat) n++;
    return n;
  }

  isRunning(slug: string, id: string): boolean {
    return this.runs.has(this.key(slug, id));
  }

  dispatch(slug: string): void {
    const profile = this.store.getProfile(slug);
    if (!profile || !existsSync(profile.path)) return;
    const ready = this.store
      .listTickets(slug)
      .filter((t) => t.status === "ready" && !t.error?.startsWith("corrupt") && !this.isRunning(slug, t.id))
      .sort((a, b) => a.order - b.order);
    for (const t of ready) {
      if (this.running(slug) >= Math.max(1, profile.maxParallel)) break;
      this.start(slug, t.id);
    }
  }

  /** Send a chat message: resumes the ticket's session right away, like typing in the terminal. */
  async chat(slug: string, id: string, text: string): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!text.trim()) throw new Error("message is empty");
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    if (this.isRunning(slug, id)) throw new ConflictError("Claude is still working on this ticket; wait for the reply or stop it");
    this.start(slug, id, { text, mode: chatModeFor(t.status) });
    return this.store.getTicket(slug, id)!;
  }

  /** Entering Planning means "shape this with Claude": start the interview once, without a click. */
  private autoRefine(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t || t.status !== "planning" || t.refineStarted || this.isRunning(slug, id) || this.shuttingDown) return;
    if (t.error?.startsWith("corrupt")) return;
    this.start(slug, id, { text: "", mode: "refine" });
  }

  private start(slug: string, id: string, chat?: ActiveRun["chat"]) {
    const run: ActiveRun = { slug, id, handle: null, promise: Promise.resolve(), targetStatus: null, stopRequested: false, chat };
    this.runs.set(this.key(slug, id), run);
    const refine = chat?.mode === "refine";
    this.patch(slug, id, refine
      ? { error: null, lastActivity: "Claude is replying…", refineStarted: true }
      : { status: "in_progress", outcome: null, error: null, lastActivity: "Starting…" });
    run.promise = this.execute(run)
      .catch((e) => {
        console.error(`run ${slug}/${id} crashed`, e);
        try {
          this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: String(e?.message ?? e) });
        } catch {}
      })
      .finally(() => {
        this.runs.delete(this.key(slug, id));
        // Tell the UI the run is over (earlier updates were sent while it was still registered).
        const now = this.store.getTicket(slug, id);
        if (now && !this.shuttingDown) this.emitTicket(slug, now);
        // When the user moved the card, updateTicket() writes the new status and dispatches itself.
        if (!this.shuttingDown && !run.targetStatus) this.dispatch(slug);
      });
  }

  /** Where the card lands after a run: refine chats never move it. */
  private endStatus(run: ActiveRun): Partial<Ticket> {
    if (run.chat?.mode === "refine") return run.targetStatus ? { status: run.targetStatus } : {};
    return { status: run.targetStatus ?? "review" };
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { slug, id } = run;
    const startedAt = nowIso();
    let session: { dir: string; sessionId: string; existed: boolean; isGit: boolean };
    try {
      session = await this.ensureSession(slug, id);
    } catch (e) {
      const msg = (e as Error).message;
      this.store.addComment(slug, id, "ai", `Could not start: ${msg}`);
      this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: msg, lastActivity: null });
      return;
    }
    if (this.shuttingDown) return;
    if (session.existed && !run.stopRequested) {
      const t0 = this.store.getTicket(slug, id)!;
      const title = t0.workdir ? sessionTitle(t0.workdir, session.sessionId) : null;
      if (await this.isSessionLive(session.sessionId, title)) {
        const msg = "This ticket's Claude session is still open in a terminal. Exit it there (Ctrl+D or /exit), then try again.";
        this.store.addComment(slug, id, "ai", msg);
        this.patch(slug, id, { ...this.endStatus(run), outcome: "blocked", error: msg, lastActivity: null });
        return;
      }
    }
    if (run.stopRequested) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...this.endStatus(run), outcome: "stopped", lastActivity: null });
      return;
    }

    const t = this.store.getTicket(slug, id)!;
    const refine = run.chat?.mode === "refine";
    const profile = this.store.getProfile(slug)!;
    const runNo = t.runCount + 1;
    const newComments = this.store.listComments(slug, id).filter((c) => c.author === "user" && (!t.lastRunAt || c.at > t.lastRunAt));
    const outputDir = this.store.outputsDir(slug, id);
    const prompt = run.chat
      ? chatPrompt(t, run.chat.text, run.chat.mode, outputDir)
      : t.runCount === 0
      ? firstRunPrompt(t, { isGit: session.isGit, linked: !!t.workdir, comments: t.workdir ? newComments : [], outputDir })
      : resumePrompt(t, newComments, outputDir);

    let lastWrite = 0;
    let pendingActivity: string | null = null;
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: session.dir,
      args: buildArgs(prompt, session.sessionId, session.existed, profile.model, refine ? "plan" : "bypassPermissions"),
      env: { CKANBAN_OUTPUT_DIR: outputDir },
      onEvent: (ev) => {
        this.store.appendActivity(slug, id, runNo, ev);
        this.bus.emit({ type: "activity", profile: slug, id, run: runNo, event: ev });
        const s = summarizeEvent(ev);
        if (!s) return;
        pendingActivity = s;
        const now = Date.now();
        if (now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          pendingActivity = null;
          this.patch(slug, id, { lastActivity: s });
        }
      },
    });

    const out = await run.handle.done;
    // Daemon is exiting: leave the ticket in_progress so recover() resumes it on next start.
    if (this.shuttingDown) return;
    const finalText = extractFinalText(out.events);
    const result = parseResult(finalText);
    const base: Partial<Ticket> = {
      ...this.endStatus(run),
      sessionStarted: true,
      ...(refine ? {} : { lastRunAt: startedAt, runCount: runNo }),
      lastActivity: pendingActivity ?? this.store.getTicket(slug, id)?.lastActivity ?? null,
    };

    if (run.handle.stopped) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...base, outcome: "stopped", error: null });
      return;
    }
    if (out.code !== 0) {
      const error = out.stderr.trim() || finalText.trim() || `claude exited with code ${out.code}`;
      this.store.addComment(slug, id, "ai", `Run failed (exit ${out.code}): ${error.split("\n").slice(-3).join("\n")}`);
      this.patch(slug, id, { ...base, outcome: "failed", error });
      return;
    }
    if (refine) {
      this.patch(slug, id, { ...base, lastActivity: null, error: null });
      return;
    }
    const current = this.store.getTicket(slug, id)!;
    const body = finalText.replace(/^.*CKANBAN_RESULT:.*$/gm, "").trim();
    // Questions must reach the user verbatim; otherwise the short summary is enough.
    const summary = (result?.status === "questions" ? body : result?.summary) || body || "(no output)";
    this.store.addComment(slug, id, "ai", summary);
    this.patch(slug, id, {
      ...base,
      outcome: result?.status === "questions" ? "needs_input" : result?.status ?? "done",
      ...(result?.status === "questions" ? { interviewed: true } : {}),
      prUrl: result?.prUrl ?? current.prUrl,
      error: null,
    });
  }

  private sessionLocks = new Map<string, Promise<unknown>>();

  /** Serialized per ticket: a run and a "copy command" click must not both create the worktree. */
  ensureSession(slug: string, id: string): Promise<{ dir: string; sessionId: string; existed: boolean; isGit: boolean }> {
    const key = this.key(slug, id);
    const prev = this.sessionLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.ensureSessionNow(slug, id));
    this.sessionLocks.set(key, next);
    next.finally(() => {
      if (this.sessionLocks.get(key) === next) this.sessionLocks.delete(key);
    }).catch(() => {});
    return next;
  }

  private async ensureSessionNow(slug: string, id: string): Promise<{ dir: string; sessionId: string; existed: boolean; isGit: boolean }> {
    const profile = this.store.getProfile(slug);
    if (!profile) throw new Error(`profile ${slug} not found`);
    if (!existsSync(profile.path)) throw new Error(`profile path does not exist: ${profile.path}`);
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const isGit = await isGitRepo(profile.path);
    const patch: Partial<Ticket> = {};
    if (t.workdir && !existsSync(t.workdir)) throw new Error(`linked session folder no longer exists: ${t.workdir}`);
    if (isGit && !t.workdir && (!t.worktree || !existsSync(t.worktree))) {
      const dir = worktreeDir(profile, id);
      const branch = t.branch ?? `ck/${id}-${slugify(t.title)}`;
      if (!existsSync(dir)) await addWorktree(profile.path, dir, branch, profile.baseBranch);
      patch.worktree = dir;
      patch.branch = branch;
    }
    if (!t.sessionId) patch.sessionId = crypto.randomUUID();
    if (Object.keys(patch).length) t = this.patch(slug, id, patch);
    const sessionId = t.sessionId!;
    return {
      dir: t.workdir ?? t.worktree ?? profile.path,
      sessionId,
      existed: !!t.sessionStarted || t.runCount > 0 || !!t.workdir || this.sessionExists(sessionId),
      isGit,
    };
  }

  async planningCommand(slug: string, id: string): Promise<string> {
    const s = await this.ensureSession(slug, id);
    const t = this.store.getTicket(slug, id)!;
    return planningCommand(s.dir, s.sessionId, planningPrompt(t, this.store.ticketPath(slug, id)), s.existed);
  }

  async createTicket(slug: string, input: { title: string; body: string; status: Status; mode?: TicketMode }): Promise<Ticket> {
    const status = input.status === "in_progress" ? "ready" : input.status;
    const t = this.store.createTicket(slug, { ...input, status });
    this.emitTicket(slug, t);
    if (status === "ready") this.dispatch(slug);
    if (status === "planning") this.autoRefine(slug, t.id);
    return this.store.getTicket(slug, t.id)!;
  }

  async updateTicket(
    slug: string,
    id: string,
    patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode">> & { expectedBody?: string },
  ): Promise<Ticket> {
    let current = this.store.getTicket(slug, id);
    if (!current) throw new Error(`ticket ${id} not found`);
    if (patch.body !== undefined && patch.expectedBody !== undefined && patch.expectedBody !== current.body) {
      throw new ConflictError("description changed since you started editing (Claude may have updated it); reload and retry");
    }
    const clean: Partial<Ticket> = {};
    if (patch.title !== undefined) clean.title = patch.title;
    if (patch.body !== undefined) clean.body = patch.body;
    if (patch.order !== undefined) clean.order = patch.order;
    if (patch.mode !== undefined) clean.mode = patch.mode;
    let status = patch.status;
    if (status === "in_progress" && !this.isRunning(slug, id)) status = "ready";

    const active = this.runs.get(this.key(slug, id));
    if (active && status && status !== "in_progress") {
      active.targetStatus = status;
      this.stopRun(active);
      await active.promise;
      current = this.store.getTicket(slug, id)!;
    }
    if (status && status !== current.status) {
      clean.status = status;
      if (patch.order === undefined) clean.order = this.store.nextOrder(slug, status);
    }
    let t = this.patch(slug, id, clean);

    if (clean.status === "done") t = await this.cleanupWorktree(slug, t);
    if (clean.status === "planning") this.autoRefine(slug, id);
    if (active || clean.status === "ready" || (clean.order !== undefined && t.status === "ready")) this.dispatch(slug);
    return this.store.getTicket(slug, id)!;
  }

  private async cleanupWorktree(slug: string, t: Ticket): Promise<Ticket> {
    const profile = this.store.getProfile(slug);
    if (!profile || !t.worktree) return t;
    const r = await removeWorktree(profile.path, t.worktree);
    if (r.removed) return this.patch(slug, t.id, { worktree: null });
    this.store.addComment(slug, t.id, "ai", `Worktree kept at ${t.worktree}: ${r.reason}`);
    return t;
  }

  async deleteTicket(slug: string, id: string): Promise<void> {
    const active = this.runs.get(this.key(slug, id));
    if (active) {
      this.stopRun(active);
      await active.promise;
    }
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (t?.worktree && profile) await removeWorktree(profile.path, t.worktree).catch(() => {});
    this.store.deleteTicket(slug, id);
    this.bus.emit({ type: "ticket.deleted", profile: slug, id });
  }

  /** Attach a Claude session the user already started in the profile folder (null unlinks). */
  async linkSession(slug: string, id: string, sessionId: string | null): Promise<Ticket> {
    const profile = this.store.getProfile(slug);
    const t = this.store.getTicket(slug, id);
    if (!profile || !t) throw new Error("ticket not found");
    if (this.isRunning(slug, id)) throw new Error("ticket is running; stop it before linking a session");
    if (sessionId !== null && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("invalid session id");
    if (t.worktree && sessionId !== null) {
      const r = await removeWorktree(profile.path, t.worktree);
      if (!r.removed) throw new Error(`ticket already has a worktree with changes (${t.worktree}); cannot switch session`);
    }
    return this.patch(slug, id, sessionId === null
      ? { sessionId: null, workdir: null }
      : { sessionId, workdir: profile.path, worktree: null, runCount: 0, lastRunAt: new Date().toISOString() });
  }

  addComment(slug: string, id: string, text: string) {
    const c = this.store.addComment(slug, id, "user", text);
    this.emitTicket(slug, this.store.getTicket(slug, id)!);
    return c;
  }

  private stopRun(run: ActiveRun) {
    run.stopRequested = true;
    run.handle?.stop();
  }

  stop(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r) return false;
    this.stopRun(r);
    return true;
  }

  stopAll(): void {
    for (const r of this.runs.values()) this.stopRun(r);
  }

  /** Kill all runs without recording an outcome; tickets stay in_progress for recover(). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const r of this.runs.values()) {
      r.stopRequested = true;
      r.handle?.stop();
    }
    await Promise.race([this.whenIdle(), Bun.sleep(6000)]);
  }

  recover(): void {
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) {
        if (t.status !== "in_progress" || this.isRunning(p.slug, t.id)) continue;
        this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; resuming.");
        this.patch(p.slug, t.id, { status: "ready" });
      }
      this.dispatch(p.slug);
    }
  }

  async whenIdle(): Promise<void> {
    while (this.runs.size) {
      await Promise.all([...this.runs.values()].map((r) => r.promise));
    }
  }
}
