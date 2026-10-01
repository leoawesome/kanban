import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFinalText, summarizeEvent } from "./activity";
import { deleteAttachments, localizeImages, referencedAttachments } from "./attachments";
import type { Bus } from "./events";
import { isSessionLive as psSessionLive, sessionTitle } from "./claude";
import { addWorktree, isGitRepo, removeWorktree, resolveBaseBranch, worktreeDir } from "./git";
import { MOVE_TO_PLANNING_RE } from "./session";
import { chatPrompt, firstRunPrompt, planningCommand, planningPrompt, resumePrompt, steerPrompt, type ChatMode } from "./prompts";
import { parseResult } from "./result";
import { DraftTracker } from "./draft";
import { buildArgs, startRun, type RunHandle } from "./runner";
import type { Store } from "./store";
import type { QueuedMessage, Status, Ticket, TicketMode } from "./types";
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
  /** Queued messages (ticket.queued) written to this claude process, keyed by id, with the text it was given. */
  inFlight: Map<string, string>;
  /** Queued message this chat run was started with; it leaves the queue once Claude reads the prompt. */
  promptMsgId?: string;
}

function replayText(ev: any): string | null {
  if (ev?.type !== "user" || !ev.isReplay) return null;
  const c = ev.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : null;
}

/** Backlog/Planning chats refine the ticket (read-only); everywhere else Claude acts on the message. */
export function chatModeFor(status: Status): ChatMode {
  return status === "backlog" || status === "planning" ? "refine" : "act";
}

const ACTIVITY_THROTTLE_MS = 1000;
const DRAFT_THROTTLE_MS = 120;

/** The session's transcript file under Claude's projects folder, if any. */
export function claudeSessionFile(sessionId: string): string | null {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return null;
  try {
    const d = readdirSync(root).find((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
    return d ? join(root, d, `${sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
}

export function claudeSessionExists(sessionId: string): boolean {
  return claudeSessionFile(sessionId) !== null;
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

  /**
   * Send a chat message: resumes the ticket's session right away, like typing in the terminal.
   * While Claude is working the message steers the run instead: Claude reads it at its next step.
   */
  async chat(slug: string, id: string, text: string): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!text.trim()) throw new Error("message is empty");
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    const active = this.runs.get(this.key(slug, id));
    if (active) {
      if (active.stopRequested || this.shuttingDown) throw new ConflictError("Claude is stopping; send your message once it has stopped");
      // Saved on the ticket until Claude reads it, so closing the chat, Stop or a restart can't lose it.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued" };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      this.steer(active, msg);
      return this.store.getTicket(slug, id)!;
    }
    this.start(slug, id, { text, mode: chatModeFor(t.status) });
    return this.store.getTicket(slug, id)!;
  }

  /** Send a message that was left unsent by Stop, as if the user typed it now. */
  async sendQueued(slug: string, id: string, msgId: string): Promise<Ticket> {
    const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
    if (!msg) throw new Error("message not found");
    if (msg.state !== "unsent") throw new ConflictError("message is already on its way to Claude");
    this.dropQueued(slug, id, [msgId]);
    return this.chat(slug, id, msg.text);
  }

  discardQueued(slug: string, id: string, msgId: string): Ticket {
    const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
    if (!msg) throw new Error("message not found");
    if (msg.state !== "unsent") throw new ConflictError("message is already on its way to Claude");
    return this.dropQueued(slug, id, [msgId]);
  }

  private dropQueued(slug: string, id: string, ids: string[]): Ticket {
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, { queued: (t.queued ?? []).filter((m) => !ids.includes(m.id)) });
  }

  /** Hand a queued message to the live claude process; false when there is none to take it yet. */
  private steer(run: ActiveRun, msg: QueuedMessage): boolean {
    if (run.inFlight.has(msg.id) || run.promptMsgId === msg.id) return true;
    const text = localizeImages(steerPrompt(msg.text), this.store.attachmentsDir);
    if (!run.handle?.send(text)) return false;
    run.inFlight.set(msg.id, text);
    return true;
  }

  /** Messages Claude has not read yet, waiting to be handed to a run. */
  private waiting(slug: string, id: string): QueuedMessage[] {
    return (this.store.getTicket(slug, id)?.queued ?? []).filter((m) => m.state === "queued");
  }

  /** Claude echoed a user message back: it has read it, so it leaves the queue. */
  private delivered(run: ActiveRun, text: string) {
    let msgId = [...run.inFlight].find(([, sent]) => sent === text)?.[0];
    if (msgId) run.inFlight.delete(msgId);
    // Anything else echoed back is the run's own prompt.
    else if (run.promptMsgId) [msgId, run.promptMsgId] = [run.promptMsgId, undefined];
    if (msgId) this.dropQueued(run.slug, run.id, [msgId]);
  }

  /** Entering Planning means "shape this with Claude": start the interview once, without a click. */
  private autoRefine(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t || t.status !== "planning" || t.refineStarted || this.isRunning(slug, id) || this.shuttingDown) return;
    if (t.error?.startsWith("corrupt")) return;
    // A linked session is already a conversation about work underway; an interview would be noise.
    if (t.workdir || t.sessionStarted) return;
    this.start(slug, id, { text: "", mode: "refine" });
  }

  private start(slug: string, id: string, chat?: ActiveRun["chat"], promptMsgId?: string) {
    const run: ActiveRun = {
      slug, id, handle: null, promise: Promise.resolve(), targetStatus: null, stopRequested: false, chat, inFlight: new Map(), promptMsgId,
    };
    this.runs.set(this.key(slug, id), run);
    this.begin(run);
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

  private begin(run: ActiveRun) {
    this.patch(run.slug, run.id, run.chat?.mode === "refine"
      ? { error: null, lastActivity: "Claude is replying…", refineStarted: true }
      : { status: "in_progress", outcome: null, error: null, lastActivity: "Starting…" });
  }

  /** One claude run, then a chat reply for each message that came in too late for it. */
  private async execute(run: ActiveRun): Promise<void> {
    await this.executeOnce(run);
    for (;;) {
      if (this.shuttingDown) return; // queue stays on the ticket; recover() delivers it
      const t = this.store.getTicket(run.slug, run.id);
      if (!t) return;
      const next = this.waiting(run.slug, run.id)[0];
      if (!next) return;
      // Stopped, or the last reply could not even start: keep them for the user to send or discard.
      if (run.stopRequested || run.promptMsgId === next.id) {
        this.patch(run.slug, run.id, { queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)) });
        return;
      }
      run.chat = { text: next.text, mode: chatModeFor(t.status) };
      run.promptMsgId = next.id;
      run.inFlight = new Map();
      run.handle = null;
      this.begin(run);
      await this.executeOnce(run);
    }
  }

  /** Where the card lands after a run: refine chats never move it. */
  private endStatus(run: ActiveRun): Partial<Ticket> {
    if (run.chat?.mode === "refine") return run.targetStatus ? { status: run.targetStatus } : {};
    return { status: run.targetStatus ?? "review" };
  }

  private async executeOnce(run: ActiveRun): Promise<void> {
    const { slug, id } = run;
    const startedAt = nowIso();
    let session: { dir: string; sessionId: string; existed: boolean; isGit: boolean };
    try {
      session = await this.ensureSession(slug, id);
    } catch (e) {
      const msg = (e as Error).message;
      this.store.addComment(slug, id, "ai", `Could not start: ${msg}`);
      // refineStarted back off: moving the card into Planning again retries the interview.
      this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: msg, lastActivity: null, ...(run.chat?.mode === "refine" ? { refineStarted: false } : {}) });
      return;
    }
    if (this.shuttingDown) return;
    // Unattended runs refuse to share a session with an open terminal; chat messages are the user's call (UI warns).
    if (session.existed && !run.stopRequested && !run.chat) {
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
    const prompt = localizeImages(run.chat
      ? chatPrompt(t, run.chat.text, run.chat.mode, outputDir)
      : t.runCount === 0
      ? firstRunPrompt(t, {
        isGit: session.isGit, linked: !!t.workdir, comments: t.workdir ? newComments : [], outputDir,
        schedule: t.scheduleId ? { id: t.scheduleId, name: this.store.getSchedule(slug, t.scheduleId)?.name ?? null, board: slug } : undefined,
      })
      : resumePrompt(t, newComments, outputDir), this.store.attachmentsDir);

    let lastWrite = 0;
    let pendingActivity: string | null = null;
    const draft = new DraftTracker();
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const emitDraft = () => {
      draftTimer = null;
      this.bus.emit({ type: "draft", profile: slug, id, text: draft.text });
    };
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: session.dir,
      args: buildArgs(session.sessionId, session.existed, profile.model, refine ? "plan" : "bypassPermissions"),
      input: prompt,
      // CKANBAN_TICKET marks board runs: the ckanban MCP/CLI refuses board changes there (no runs starting runs).
      env: { CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${id}` },
      onEvent: (ev) => {
        const changed = draft.feed(ev);
        if (changed !== null) {
          // Clears go out at once; growing text is batched (~8 updates/s).
          if (changed === "") {
            if (draftTimer) clearTimeout(draftTimer);
            emitDraft();
          } else if (!draftTimer) draftTimer = setTimeout(emitDraft, DRAFT_THROTTLE_MS);
        }
        if (ev?.type === "stream_event") return;
        const read = replayText(ev);
        if (read !== null) this.delivered(run, read);
        this.store.appendActivity(slug, id, runNo, ev);
        this.bus.emit({ type: "activity", profile: slug, id, run: runNo, event: ev });
        const s = summarizeEvent(ev);
        // Keep "Stopping…" on the card until the process is gone.
        if (!s || run.stopRequested) return;
        pendingActivity = s;
        const now = Date.now();
        if (now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          pendingActivity = null;
          this.patch(slug, id, { lastActivity: s });
        }
      },
    });

    // Messages sent while the run was starting up, or left over from a run the daemon restarted.
    for (const msg of this.waiting(slug, id)) this.steer(run, msg);

    const out = await run.handle.done;
    if (draftTimer) clearTimeout(draftTimer);
    if (draft.text) this.bus.emit({ type: "draft", profile: slug, id, text: "" });
    // Daemon is exiting: leave the ticket in_progress so recover() resumes it on next start.
    if (this.shuttingDown) return;
    const finalText = extractFinalText(out.events);
    // A steering message can get its own turn after the result line; the ticket outcome is still the last one given.
    const result = parseResult(finalText) ?? out.events
      .filter((e) => e?.type === "result" && typeof e.result === "string")
      .map((e) => parseResult(e.result))
      .findLast((r) => r !== null) ?? null;
    const base: Partial<Ticket> = {
      ...this.endStatus(run),
      sessionStarted: true,
      ...(refine ? {} : { lastRunAt: startedAt, runCount: runNo }),
      lastActivity: pendingActivity ?? this.store.getTicket(slug, id)?.lastActivity ?? null,
    };

    if (run.handle.stopped) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null });
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
    // A Review/Done message that only asked for planning: show the ticket where it really is.
    if (run.chat?.mode === "act" && !run.targetStatus && result?.status !== "blocked" && MOVE_TO_PLANNING_RE.test(finalText)) {
      this.patch(slug, id, {
        ...base, status: "planning",
        outcome: null, error: null, refineStarted: true, lastActivity: null,
      });
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
    // A ticket that already ran in the folder itself stays there: its Claude session belongs to that folder.
    const ranInPlace = !t.worktree && (!!t.sessionStarted || t.runCount > 0);
    if (isGit && !t.workdir && !ranInPlace && (!t.worktree || !existsSync(t.worktree))) {
      const dir = worktreeDir(profile, id);
      const branch = t.branch ?? `ck/${id}-${slugify(t.title)}`;
      const base = existsSync(dir) ? profile.baseBranch : await resolveBaseBranch(profile.path, profile.baseBranch);
      if (base === null) {
        // Fresh `git init` with no commits: nothing to branch from, so run in the folder rather than fail.
        patch.notice = "This repo has no commits yet, so Claude works directly in your folder instead of an isolated worktree. Make a first commit to give new tickets their own worktree.";
      } else {
        if (base !== profile.baseBranch) {
          console.log(`profile ${slug}: base branch "${profile.baseBranch}" not found, using "${base}"`);
          const fixed = { ...profile, baseBranch: base };
          this.store.saveProfile(fixed);
          this.bus.emit({ type: "profile.updated", slug, profile: fixed });
          if (profile.baseBranch) patch.notice = `Base branch "${profile.baseBranch}" was not found in this repo, so the board now uses "${base}".`;
        }
        if (!existsSync(dir)) await addWorktree(profile.path, dir, branch, base);
        patch.worktree = dir;
        patch.branch = branch;
      }
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
    return planningCommand(s.dir, s.sessionId, localizeImages(planningPrompt(t, this.store.ticketPath(slug, id)), this.store.attachmentsDir), s.existed);
  }

  async createTicket(slug: string, input: { title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string }): Promise<Ticket> {
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
    patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice">> & { expectedBody?: string },
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
    if (patch.notice !== undefined) clean.notice = patch.notice;
    let status = patch.status;
    if (status === "in_progress" && !this.isRunning(slug, id)) status = "ready";

    const active = this.runs.get(this.key(slug, id));
    if (active && status && status !== "in_progress") {
      active.targetStatus = status;
      this.stopRun(active);
      await active.promise;
      current = this.store.getTicket(slug, id)!;
    }
    // The store places the ticket in its new column unless the patch carries a drop position.
    if (status && status !== current.status) clean.status = status;
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
    if (t) deleteAttachments(this.store.attachmentsDir, this.attachmentsOf(slug, t));
    this.store.deleteTicket(slug, id);
    this.bus.emit({ type: "ticket.deleted", profile: slug, id });
  }

  /** Images pasted into the ticket: its description, comments and chat (the Claude session transcript). */
  private attachmentsOf(slug: string, t: Ticket): string[] {
    const texts = [t.body, ...this.store.listComments(slug, t.id).map((c) => c.text), ...(t.queued ?? []).map((m) => m.text)];
    const file = t.sessionId ? claudeSessionFile(t.sessionId) : null;
    if (file) {
      try {
        texts.push(readFileSync(file, "utf8"));
      } catch {}
    }
    return referencedAttachments(...texts);
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
      // Linked work already exists and the next step is the user's: land in Review ("Your turn").
      : { sessionId, workdir: profile.path, worktree: null, runCount: 0, lastRunAt: new Date().toISOString(), status: "review" });
  }

  addComment(slug: string, id: string, text: string) {
    const c = this.store.addComment(slug, id, "user", text);
    this.emitTicket(slug, this.store.getTicket(slug, id)!);
    return c;
  }

  private stopRun(run: ActiveRun) {
    // Show the stop at once: setup (worktree, session checks) or SIGTERM can take a while to finish.
    if (!run.stopRequested && this.store.getTicket(run.slug, run.id)) this.patch(run.slug, run.id, { lastActivity: "Stopping…" });
    run.stopRequested = true;
    run.handle?.stop();
  }

  stop(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (r) {
      this.stopRun(r);
      return true;
    }
    // In Progress with no run behind it (e.g. the daemon lost it): clear the card instead of leaving it stuck.
    const t = this.store.getTicket(slug, id);
    if (t?.status !== "in_progress") return false;
    this.store.addComment(slug, id, "ai", "Run stopped by user.");
    this.patch(slug, id, { status: "review", outcome: "stopped", error: null, lastActivity: null });
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
      // Messages a restarted chat run never got to: answer them in a chat reply now.
      for (const t of this.store.listTickets(p.slug)) {
        const next = this.waiting(p.slug, t.id)[0];
        if (!next || this.isRunning(p.slug, t.id) || t.status === "ready" || t.error?.startsWith("corrupt")) continue;
        this.start(p.slug, t.id, { text: next.text, mode: chatModeFor(t.status) }, next.id);
      }
    }
  }

  async whenIdle(): Promise<void> {
    while (this.runs.size) {
      await Promise.all([...this.runs.values()].map((r) => r.promise));
    }
  }
}
