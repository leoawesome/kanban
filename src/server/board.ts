import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFinalText, summarizeEvent } from "./activity";
import type { Bus } from "./events";
import { addWorktree, isGitRepo, removeWorktree, worktreeDir } from "./git";
import { firstRunPrompt, planningCommand, planningPrompt, resumePrompt } from "./prompts";
import { parseResult } from "./result";
import { buildArgs, startRun, type RunHandle } from "./runner";
import type { Store } from "./store";
import type { Status, Ticket } from "./types";
import { nowIso, slugify } from "./util";

export interface BoardOptions {
  claudeBin: string;
  /** Whether Claude has a stored session with this id (used to pick --resume vs --session-id). */
  sessionExists?: (sessionId: string) => boolean;
}

interface ActiveRun {
  slug: string;
  id: string;
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Status to land on when the run ends because the user moved the card. */
  targetStatus: Status | null;
  stopRequested: boolean;
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

export class Board {
  private runs = new Map<string, ActiveRun>();
  private shuttingDown = false;
  private sessionExists: (id: string) => boolean;

  constructor(private store: Store, private bus: Bus, private opts: BoardOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
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

  running(slug: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.slug === slug) n++;
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

  private start(slug: string, id: string) {
    const run: ActiveRun = { slug, id, handle: null, promise: Promise.resolve(), targetStatus: null, stopRequested: false };
    this.runs.set(this.key(slug, id), run);
    this.patch(slug, id, { status: "in_progress", outcome: null, error: null, lastActivity: "Starting…" });
    run.promise = this.execute(run)
      .catch((e) => {
        console.error(`run ${slug}/${id} crashed`, e);
        try {
          this.patch(slug, id, { status: run.targetStatus ?? "review", outcome: "failed", error: String(e?.message ?? e) });
        } catch {}
      })
      .finally(() => {
        this.runs.delete(this.key(slug, id));
        if (!this.shuttingDown) this.dispatch(slug);
      });
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
      this.patch(slug, id, { status: run.targetStatus ?? "review", outcome: "failed", error: msg, lastActivity: null });
      return;
    }
    if (run.stopRequested) {
      this.patch(slug, id, { status: run.targetStatus ?? "review", outcome: "stopped", lastActivity: null });
      return;
    }

    const t = this.store.getTicket(slug, id)!;
    const profile = this.store.getProfile(slug)!;
    const runNo = t.runCount + 1;
    const prompt = t.runCount === 0
      ? firstRunPrompt(t, session.isGit)
      : resumePrompt(t, this.store.listComments(slug, id).filter((c) => c.author === "user" && (!t.lastRunAt || c.at > t.lastRunAt)));

    let lastWrite = 0;
    let pendingActivity: string | null = null;
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: session.dir,
      args: buildArgs(prompt, session.sessionId, session.existed, profile.model),
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
      status: run.targetStatus ?? "review",
      lastRunAt: startedAt,
      runCount: runNo,
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
    const current = this.store.getTicket(slug, id)!;
    const summary = result?.summary || finalText.replace(/^.*CKANBAN_RESULT:.*$/m, "").trim() || "(no output)";
    this.store.addComment(slug, id, "ai", summary);
    this.patch(slug, id, {
      ...base,
      outcome: result?.status ?? "done",
      prUrl: result?.prUrl ?? current.prUrl,
      error: null,
    });
  }

  async ensureSession(slug: string, id: string): Promise<{ dir: string; sessionId: string; existed: boolean; isGit: boolean }> {
    const profile = this.store.getProfile(slug);
    if (!profile) throw new Error(`profile ${slug} not found`);
    if (!existsSync(profile.path)) throw new Error(`profile path does not exist: ${profile.path}`);
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const isGit = await isGitRepo(profile.path);
    const patch: Partial<Ticket> = {};
    if (isGit && (!t.worktree || !existsSync(t.worktree))) {
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
      dir: t.worktree ?? profile.path,
      sessionId,
      existed: t.runCount > 0 || this.sessionExists(sessionId),
      isGit,
    };
  }

  async planningCommand(slug: string, id: string): Promise<string> {
    const s = await this.ensureSession(slug, id);
    const t = this.store.getTicket(slug, id)!;
    return planningCommand(s.dir, s.sessionId, planningPrompt(t, this.store.ticketPath(slug, id)), s.existed);
  }

  async createTicket(slug: string, input: { title: string; body: string; status: Status }): Promise<Ticket> {
    const status = input.status === "in_progress" ? "ready" : input.status;
    const t = this.store.createTicket(slug, { ...input, status });
    this.emitTicket(slug, t);
    if (status === "ready") this.dispatch(slug);
    return this.store.getTicket(slug, t.id)!;
  }

  async updateTicket(slug: string, id: string, patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order">>): Promise<Ticket> {
    const current = this.store.getTicket(slug, id);
    if (!current) throw new Error(`ticket ${id} not found`);
    const clean: Partial<Ticket> = {};
    if (patch.title !== undefined) clean.title = patch.title;
    if (patch.body !== undefined) clean.body = patch.body;
    if (patch.order !== undefined) clean.order = patch.order;
    let status = patch.status;
    if (status === "in_progress" && !this.isRunning(slug, id)) status = "ready";

    const active = this.runs.get(this.key(slug, id));
    if (active && status && status !== "in_progress") {
      active.targetStatus = status;
      this.stopRun(active);
      await active.promise;
    }
    if (status && status !== current.status) {
      clean.status = status;
      if (patch.order === undefined) clean.order = this.store.nextOrder(slug, status);
    }
    let t = this.patch(slug, id, clean);

    if (clean.status === "done") t = await this.cleanupWorktree(slug, t);
    if (clean.status === "ready" || (clean.order !== undefined && t.status === "ready")) this.dispatch(slug);
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
    for (const r of this.runs.values()) r.handle?.stop();
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
