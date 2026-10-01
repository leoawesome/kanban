import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFinalText, summarizeEvent } from "./activity";
import { deleteAttachments, localizeImages, referencedAttachments } from "./attachments";
import type { Bus } from "./events";
import { isSessionLive as psSessionLive, sessionTitle } from "./claude";
import { addWorktree, isGitRepo, removeWorktree, resolveBaseBranch, worktreeDir } from "./git";
import { MOVE_TO_PLANNING_RE } from "./session";
import { chatPrompt, firstRunPrompt, orchestratorPrompt, planningCommand, planningPrompt, resumePrompt, steerPrompt, type ChatMode, type PlanWake } from "./prompts";
import {
  childrenOf, DEFAULT_MAX_CONCURRENT, findCycle, planActive, planProblem, planStep, planTable, resolveDeps, wakeupCap,
} from "./plan";
import { run as runCmd } from "./git";
import { parseResult } from "./result";
import { DraftTracker } from "./draft";
import { buildArgs, startRun, type RunHandle } from "./runner";
import type { Store } from "./store";
import type { Plan, QueuedMessage, Status, Ticket, TicketMode } from "./types";
import { nowIso, slugify } from "./util";

export interface BoardOptions {
  claudeBin: string;
  /** Whether Claude has a stored session with this id (used to pick --resume vs --session-id). */
  sessionExists?: (sessionId: string) => boolean;
  /** Whether an interactive claude process currently has this session open. */
  isSessionLive?: (sessionId: string, title: string | null) => Promise<boolean>;
  /** Tells the user something needs them while they're away (default: a macOS notification). */
  notify?: (title: string, body: string) => void;
  /** Child events that arrive within this window wake the planner once (default 3s). */
  planWakeDelayMs?: number;
}

/** macOS notification; silently nothing elsewhere or when osascript fails. */
export function systemNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const q = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").slice(0, 240));
  runCmd(["osascript", "-e", `display notification ${q(body)} with title ${q(title)}`], homedir()).catch(() => {});
}

interface ActiveRun {
  slug: string;
  id: string;
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Status to land on when the run ends because the user moved the card. */
  targetStatus: Status | null;
  stopRequested: boolean;
  /**
   * Set for runs started from the ticket chat (not the Ready queue). raw: text is the full prompt (planner wake-ups);
   * returnTo: the column such a run goes back to, since a wake-up is housekeeping, not new work to review.
   */
  chat?: { text: string; mode: ChatMode; raw?: boolean; returnTo?: Status };
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
  private notify: (title: string, body: string) => void;

  constructor(private store: Store, private bus: Bus, private opts: BoardOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    this.isSessionLive = opts.isSessionLive ?? psSessionLive;
    this.notify = opts.notify ?? systemNotify;
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
        if (now && !this.shuttingDown) {
          if (now.runStartedAt) this.patch(slug, id, { runStartedAt: null });
          else this.emitTicket(slug, now);
        }
        // When the user moved the card, updateTicket() writes the new status and dispatches itself.
        if (!this.shuttingDown && !run.targetStatus) this.dispatch(slug);
        if (!this.shuttingDown) this.advancePlans(slug);
      });
  }

  private begin(run: ActiveRun) {
    this.patch(run.slug, run.id, run.chat?.mode === "refine"
      ? { error: null, lastActivity: "Claude is replying…", refineStarted: true, runStartedAt: nowIso() }
      : { status: "in_progress", outcome: null, error: null, lastActivity: "Starting…", runStartedAt: nowIso() });
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
    return { status: run.targetStatus ?? run.chat?.returnTo ?? "review" };
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
    const prompt = localizeImages(run.chat?.raw
      ? run.chat.text
      : run.chat
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
      // A planner wake-up reports its children's PRs; the planner keeps its own.
      prUrl: run.chat?.raw ? current.prUrl : result?.prUrl ?? current.prUrl,
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

  async createTicket(
    slug: string,
    input: { title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string; parentId?: string; planKey?: string; dependsOn?: string[] },
  ): Promise<Ticket> {
    const status = input.status === "in_progress" ? "ready" : input.status;
    const t = this.store.createTicket(slug, { ...input, status });
    this.emitTicket(slug, t);
    // The planner's "Review proposal" badge depends on which of its proposed tickets exist.
    const parent = input.parentId ? this.store.getTicket(slug, input.parentId) : null;
    if (parent) this.emitTicket(slug, parent);
    if (status === "ready") this.dispatch(slug);
    if (status === "planning") this.autoRefine(slug, t.id);
    if (parent) this.advancePlans(slug);
    return this.store.getTicket(slug, t.id)!;
  }

  async updateTicket(
    slug: string,
    id: string,
    patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "dependsOn">> & { expectedBody?: string },
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
    if (patch.dependsOn !== undefined) {
      clean.dependsOn = patch.dependsOn;
      if (current.parentId) {
        const siblings = childrenOf(this.store.listTickets(slug), current.parentId).map((s) => (s.id === id ? { ...s, dependsOn: patch.dependsOn } : s));
        const me = siblings.find((s) => s.id === id)!;
        const { missing } = resolveDeps(me, siblings);
        if (missing.length) throw new Error(`unknown dependency ${missing.map((m) => `"${m}"`).join(", ")}: use a sibling's ticket id or key`);
        const cycle = findCycle(siblings);
        if (cycle) throw new Error(`dependency cycle: ${cycle.join(" → ")}`);
      }
    }
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
    this.advancePlans(slug);
    return this.store.getTicket(slug, id)!;
  }

  // ---- Plans: a planner ticket runs its children unattended (see plan.ts) ----

  /** Start (or resume) the planner's plan: children switch to auto mode and start in dependency order. */
  startPlan(slug: string, id: string, opts: { maxConcurrent?: number } = {}): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const kids = childrenOf(this.store.listTickets(slug), id);
    const problem = planProblem(kids);
    if (problem) throw new Error(`can't start the plan: ${problem}`);
    const prev = t.plan;
    const resuming = prev && prev.state !== "done";
    const plan: Plan = resuming
      ? {
        ...prev,
        state: prev.awaiting === "final" || prev.state === "finishing" ? "finishing" : "running",
        reason: null,
        // A stuck plan starts fresh: its last wake-up is over and the planner looks at every open child again.
        ...(prev.state === "stuck" ? { wakeups: 0, awaiting: null, seen: {} } : {}),
      }
      : { state: "running", maxConcurrent: DEFAULT_MAX_CONCURRENT, wakeups: 0, startedAt: nowIso(), originalCount: kids.length, inbox: [], seen: {}, retries: {}, awaiting: null };
    if (opts.maxConcurrent !== undefined) plan.maxConcurrent = clampConcurrency(opts.maxConcurrent);
    // Unattended: children must not stop to interview the user.
    for (const k of kids) if (k.status === "backlog" && k.mode !== "auto") this.patch(slug, k.id, { mode: "auto" });
    const out = this.patch(slug, id, { plan, ...(t.outcome && t.outcome !== "done" ? { outcome: null } : {}) });
    this.store.addComment(slug, id, "ai", resuming ? "Plan resumed." : `Plan started: ${kids.length} child tickets, ${plan.maxConcurrent} at a time.`);
    this.advancePlans(slug);
    return this.store.getTicket(slug, id) ?? out;
  }

  /** Pause: no new children start and the planner isn't woken; running children finish. */
  pausePlan(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    if (t.plan.state === "done") return t;
    this.store.addComment(slug, id, "ai", "Plan paused.");
    return this.patch(slug, id, { plan: { ...t.plan, state: "paused" } });
  }

  setPlanConcurrency(slug: string, id: string, n: number): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    const out = this.patch(slug, id, { plan: { ...t.plan, maxConcurrent: clampConcurrency(n) } });
    this.advancePlans(slug);
    return out;
  }

  /** The planner ticket a run belongs to, if it is running a plan; used to scope its board rights. */
  activePlanner(slug: string, runTicketId: string): Ticket | null {
    const t = this.store.getTicket(slug, runTicketId);
    return t && planActive(t.plan) ? t : null;
  }

  /** The planner restarts a child that already ran: counted, and refused past MAX_RETRIES. */
  countRetry(slug: string, plannerId: string, childId: string, max: number): void {
    const p = this.store.getTicket(slug, plannerId);
    if (!p?.plan) return;
    const n = (p.plan.retries?.[childId] ?? 0) + 1;
    if (n > max) throw new Error(`retry limit reached: ${childId} was already restarted ${max} times; skip or split it, or end with "blocked" for the user`);
    this.patch(slug, plannerId, { plan: { ...p.plan, retries: { ...p.plan.retries, [childId]: n } } });
  }

  private advancing = new Set<string>();
  /** When a planner with waiting events gets woken, per planner: children that fail together arrive as one message. */
  private wakeDue = new Map<string, number>();
  private advanceAgain = new Set<string>();

  /** Move every running plan on the board forward. Cheap and idempotent: call it after any change. */
  advancePlans(slug: string): void {
    if (this.shuttingDown) return;
    if (this.advancing.has(slug)) {
      this.advanceAgain.add(slug);
      return;
    }
    this.advancing.add(slug);
    try {
      do {
        this.advanceAgain.delete(slug);
        const all = this.store.listTickets(slug);
        let started = false;
        for (const p of all) {
          if (!p.plan || p.plan.state === "done" || p.plan.state === "paused") continue;
          try {
            started = this.advancePlan(slug, p, childrenOf(all, p.id)) || started;
          } catch (e) {
            console.error(`plan ${slug}/${p.id}:`, e);
          }
        }
        if (started) this.dispatch(slug);
      } while (this.advanceAgain.has(slug));
    } finally {
      this.advancing.delete(slug);
    }
  }

  /** One plan; true when it moved children to Ready. */
  private advancePlan(slug: string, planner: Ticket, kids: Ticket[]): boolean {
    let plan = { ...planner.plan! };
    const plannerBusy = this.isRunning(slug, planner.id);
    // The planner's last wake-up has finished: its outcome decides whether we go on.
    if (plan.awaiting && !plannerBusy) {
      const o = planner.outcome;
      if (o === "blocked" || o === "needs_input" || o === "failed" || o === "stopped") {
        this.stuck(slug, planner, plan, o === "needs_input" ? "the planner has questions for you" : `the planner's run ${o === "blocked" ? "is blocked" : o}`);
        return false;
      }
      if (plan.awaiting === "final") {
        this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, finishedAt: nowIso() } });
        this.store.addComment(slug, planner.id, "ai", "Plan done: all child tickets finished and the final check ran.");
        this.notify(`Plan done: ${planner.title}`, "All child tickets finished. Summary in the ticket's outputs.");
        return false;
      }
      plan.awaiting = null;
    }
    if (plan.state === "stuck") return false;
    if (plan.state === "finishing") {
      if (!plan.awaiting && !plannerBusy) this.wake(slug, planner, plan, "final", [], kids);
      else if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
      return false;
    }
    const step = planStep(plan, kids, (id) => this.isRunning(slug, id));
    for (const cid of step.start) this.patch(slug, cid, { status: "ready", mode: "auto", outcome: null, error: null });
    if (step.events.length) {
      plan.inbox = [...(plan.inbox ?? []), ...step.events.map((e) => e.line)];
      plan.seen = { ...plan.seen, ...Object.fromEntries(step.events.map((e) => [e.childId, e.sig])) };
    }
    const inbox = plan.inbox ?? [];
    if (!plannerBusy && !plan.awaiting) {
      if (inbox.length) {
        if (plan.wakeups >= wakeupCap(Math.max(plan.originalCount, kids.length))) {
          this.stuck(slug, planner, plan, `wake-up limit reached (${plan.wakeups}); waiting events: ${inbox.join("; ")}`);
          return step.start.length > 0;
        }
        const key = this.key(slug, planner.id);
        const due = this.wakeDue.get(key);
        if (due === undefined) {
          const delay = this.opts.planWakeDelayMs ?? 3000;
          this.wakeDue.set(key, Date.now() + delay);
          setTimeout(() => this.advancePlans(slug), delay + 5);
        } else if (Date.now() >= due) {
          this.wakeDue.delete(key);
          this.wake(slug, planner, plan, "event", inbox, kids);
          return step.start.length > 0;
        }
        if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
        return step.start.length > 0;
      }
      if (step.allComplete) {
        this.wake(slug, planner, { ...plan, state: "finishing" }, "final", [], kids);
        return false;
      }
      if (step.deadEnd && !step.start.length) {
        this.stuck(slug, planner, plan, step.deadEnd);
        return false;
      }
    }
    if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
    return step.start.length > 0;
  }

  /** Resume the planner's session with what happened; several events arrive as one message. */
  private wake(slug: string, planner: Ticket, plan: Plan, kind: PlanWake, events: string[], kids: Ticket[]) {
    const text = orchestratorPrompt(planner, { kind, events, table: planTable(kids), board: slug, outputDir: this.store.outputsDir(slug, planner.id) });
    this.patch(slug, planner.id, { plan: { ...plan, inbox: [], awaiting: kind, wakeups: plan.wakeups + 1 } });
    // Back to where it was (In progress only if a restart cut a wake-up off).
    const returnTo = planner.status === "in_progress" ? "review" : planner.status;
    this.start(slug, planner.id, { text, mode: "act", raw: true, returnTo });
  }

  private stuck(slug: string, planner: Ticket, plan: Plan, reason: string) {
    this.patch(slug, planner.id, { plan: { ...plan, state: "stuck", awaiting: null, reason } });
    this.store.addComment(slug, planner.id, "ai", `Plan stuck: ${reason}. Fix what's needed, then press Resume plan.`);
    this.notify(`Plan stuck: ${planner.title}`, reason);
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
        if (t.plan?.awaiting && planActive(t.plan)) {
          // A planner wake-up was cut off: wake it again with the children's current state.
          this.store.addComment(p.slug, t.id, "ai", "Planner interrupted by daemon restart; waking it again.");
          this.patch(p.slug, t.id, {
            status: "review", outcome: null, lastActivity: null,
            plan: { ...t.plan, state: t.plan.awaiting === "final" ? "finishing" : t.plan.state, awaiting: null, seen: {} },
          });
          continue;
        }
        this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; resuming.");
        this.patch(p.slug, t.id, { status: "ready" });
      }
      this.dispatch(p.slug);
      this.advancePlans(p.slug);
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

function clampConcurrency(n: number): number {
  return Math.max(1, Math.min(10, Math.round(Number(n) || DEFAULT_MAX_CONCURRENT)));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
