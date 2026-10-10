// Huddles: a shared message room where several headless Claude sessions work on one ticket together.
// The host ticket's own session is @main (the coordinator); agents (reviewer, QA, ...) are sessions the huddle runs
// itself, outside the board's run slots (only maxParticipants limits them). Other tickets' sessions can be invited.
// The daemon stamps every message's sender, keeps the log append-only, caps the roster, and one Stop stops everyone.
//
// Routing: an @mentioned participant is woken (steered if it is running, else its session resumes with what it
// hasn't read). Monitor-mode participants get every new message at their next turn boundary; tagged ones sleep until
// mentioned. Nobody gets their own messages. System messages are context only and wake nobody.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { summarizeEvent } from "./activity";
import { mcpConfig } from "./agents";
import { claudeSessionExists, type Board } from "./board";
import type { Bus } from "./events";
import { addWorktree, isGitRepo, worktreeDir } from "./git";
import {
  DEFAULT_MAX_PARTICIPANTS, handleBase, HUDDLE_AGENT_ENV, MAIN_HANDLE, NO_EDIT_TOOLS, parseMentions, RESERVED_HANDLES, rosterEntryError,
  rosterError, USER_HANDLE, type RosterEntry,
} from "./huddle-roster";
import {
  deletePreset, type HuddlePreset, type HuddlePresetView, MAIN_PRESET, mergePresets, savePreset,
} from "./huddle-presets";
import { huddleAgentPrompt, huddleAgentSystemPrompt, huddleDigest, huddleMainPrompt } from "./prompts";
import { buildArgs, MONITOR_IDLE_MS, startRun, type RunHandle } from "./runner";
import type { Store } from "./store";
import type { Huddle, HuddleFinding, HuddleMessage, HuddleMessageKind, HuddleMode, HuddleParticipant, Ticket } from "./types";
import { newId, nowIso } from "./util";

export class HuddleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Unread messages handed to a session at once; older ones are left to huddle_read. */
const DIGEST_MAX = 40;
const ACTIVITY_THROTTLE_MS = 1000;

export type ParticipantView = Omit<HuddleParticipant, "token"> & { running: boolean };
export type HuddleView = Omit<Huddle, "participants"> & { participants: ParticipantView[]; hostTitle: string | null };

/** Who is calling, from the request: a board run's ticket (RUN_HEADER) and a huddle agent (HUDDLE_HEADER). Neither: the user. */
export interface Caller {
  run?: string | null;
  agent?: string | null;
}

export interface HuddleOptions {
  claudeBin: string;
  /** How long a monitor-mode session stays open between turns (default 30 min). */
  idleMs?: number;
  sessionExists?: (sessionId: string) => boolean;
}

interface AgentRun {
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Between Claude's result and its next turn. */
  idle: boolean;
  /** Monitor: messages came in mid-turn; they go in at the next turn boundary. */
  pending: boolean;
  /** Messages came in after input closed: deliver them in a new run once this one ends. */
  again: boolean;
  stopRequested: boolean;
}

const isCoordinator = (h: Huddle, p: HuddleParticipant) => p.kind === "ticket-main" && p.ticketId === h.hostTicket;
const canManage = (h: Huddle, p: HuddleParticipant) => p.kind === "human" || isCoordinator(h, p) || p.lead;

export class Huddles {
  private runs = new Map<string, AgentRun>();
  /** Ticket sessions (monitor mode) with messages waiting until their current run ends, "<slug>/<huddle>/<handle>". */
  private mainPending = new Set<string>();
  private shuttingDown = false;
  private sessionExists: (id: string) => boolean;

  constructor(private store: Store, private board: Board, private bus: Bus, private opts: HuddleOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    // A monitor-mode ticket session gets what came in while it worked once its run is over.
    bus.on((e) => {
      if (e.type !== "ticket.updated" || !this.mainPending.size) return;
      for (const key of [...this.mainPending]) {
        const [slug, hid, handle] = key.split("/");
        if (slug !== e.profile) continue;
        const h = this.store.getHuddle(slug, hid);
        const p = h?.participants.find((x) => x.handle === handle);
        if (!h || !p || p.ticketId !== e.ticket.id || this.board.isRunning(slug, e.ticket.id)) continue;
        this.mainPending.delete(key);
        queueMicrotask(() => this.deliverNow(slug, hid, handle));
      }
    });
  }

  private key(slug: string, hid: string, handle: string) {
    return `${slug}/${hid}/${handle}`;
  }

  // ---- Reading ----

  get(slug: string, hid: string): Huddle {
    const h = this.store.getHuddle(slug, hid);
    if (!h) throw new HuddleError(404, `huddle ${hid} not found`);
    return h;
  }

  isRunning(slug: string, h: Huddle, p: HuddleParticipant): boolean {
    if (p.kind === "agent") return this.runs.has(this.key(slug, h.id, p.handle));
    if (p.kind === "ticket-main" && p.ticketId) return this.board.isRunning(slug, p.ticketId);
    return false;
  }

  view(slug: string, h: Huddle): HuddleView {
    return {
      ...h,
      hostTitle: this.store.getTicket(slug, h.hostTicket)?.title ?? null,
      participants: h.participants.map(({ token: _t, ...p }) => {
        const running = this.isRunning(slug, h, p);
        // A ticket session's status is its ticket's run.
        const status = p.kind === "ticket-main" && p.status !== "stopped" ? (running ? "working" : "idle") : p.status;
        return { ...p, status, running };
      }),
    };
  }

  list(slug: string, ticketId?: string): HuddleView[] {
    return this.store.listHuddles(slug)
      .filter((h) => !ticketId || h.hostTicket === ticketId || h.participants.some((p) => p.ticketId === ticketId))
      .map((h) => this.view(slug, h));
  }

  /** Messages, newest page first: `before` pages back, `since` reads forward from a seq. */
  messages(slug: string, hid: string, q: { before?: number; since?: number; limit?: number } = {}): { messages: HuddleMessage[]; hasMore: boolean } {
    this.get(slug, hid);
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    let all = this.store.readHuddleMessages(slug, hid);
    if (q.since !== undefined) {
      all = all.filter((m) => m.seq > q.since!);
      return { messages: all.slice(0, limit), hasMore: all.length > limit };
    }
    if (q.before !== undefined) all = all.filter((m) => m.seq < q.before!);
    return { messages: all.slice(-limit), hasMore: all.length > limit };
  }

  /**
   * The participant a request comes from. The sender of everything is decided here, from the run's identity:
   * an agent proves who it is with its token, a ticket run is that ticket's session, no run header is the user.
   * hid "current": the caller's own huddle.
   */
  identify(slug: string, hid: string, who: Caller): { h: Huddle; me: HuddleParticipant } {
    if (who.agent) {
      const [aHid, handle, token] = who.agent.split("/");
      if (hid !== "current" && hid !== aHid) throw new HuddleError(403, `you are in huddle ${aHid}, not ${hid}`);
      const h = this.get(slug, aHid);
      const me = h.participants.find((p) => p.handle === handle && p.kind === "agent");
      if (!me || !token || me.token !== token) throw new HuddleError(403, "unknown huddle agent");
      if (who.run && who.run !== `${slug}/${h.hostTicket}`) throw new HuddleError(403, "huddle agents can only reach their own huddle");
      return { h, me };
    }
    if (who.run) {
      const [runSlug, ticketId] = who.run.split("/");
      if (runSlug !== slug || !ticketId) throw new HuddleError(403, `a run can only reach huddles on its own board (${runSlug})`);
      const mine = (h: Huddle) => h.participants.find((p) => p.kind === "ticket-main" && p.ticketId === ticketId);
      let h: Huddle | undefined;
      if (hid === "current") {
        // Its newest open huddle, preferring one it hosts.
        const open = this.store.listHuddles(slug).filter((x) => x.status !== "closed" && mine(x)).reverse();
        h = open.find((x) => x.hostTicket === ticketId) ?? open[0];
        if (!h) throw new HuddleError(404, `ticket ${ticketId} is in no open huddle`);
      } else h = this.get(slug, hid);
      const me = mine(h);
      if (!me) throw new HuddleError(403, `ticket ${ticketId} is not in huddle ${h.id}`);
      return { h, me };
    }
    if (hid === "current") throw new HuddleError(400, "pass a huddle id");
    const h = this.get(slug, hid);
    return { h, me: h.participants.find((p) => p.kind === "human")! };
  }

  // ---- Role presets (built-ins + the board's huddle-presets.json) ----

  presets(slug: string): HuddlePresetView[] {
    return mergePresets(this.store.listHuddlePresets(slug));
  }

  private presetMap(slug: string): Map<string, HuddlePreset> {
    return new Map(this.presets(slug).map((p) => [p.name, p]));
  }

  /** Add or change a board preset (a built-in's name overrides it). */
  savePreset(slug: string, input: unknown): HuddlePresetView {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    let r: ReturnType<typeof savePreset>;
    try {
      r = savePreset(this.store.listHuddlePresets(slug), input);
    } catch (e) {
      throw new HuddleError(400, (e as Error).message);
    }
    this.store.saveHuddlePresets(slug, r.board);
    return this.presets(slug).find((p) => p.name === r.preset.name)!;
  }

  /** Delete a board preset, or reset an overridden built-in. Built-ins themselves can't be deleted. */
  deletePreset(slug: string, name: string): { reset: boolean; presets: HuddlePresetView[] } {
    let r: ReturnType<typeof deletePreset>;
    try {
      r = deletePreset(this.store.listHuddlePresets(slug), name);
    } catch (e) {
      throw new HuddleError(/built-in/.test((e as Error).message) ? 409 : 404, (e as Error).message);
    }
    this.store.saveHuddlePresets(slug, r.board);
    return { reset: r.reset, presets: this.presets(slug) };
  }

  // ---- Changing ----

  /** Read, change and save a huddle in one step (nothing else runs in between), then tell the UI. */
  private update(slug: string, hid: string, fn: (h: Huddle) => void): Huddle {
    const h = this.get(slug, hid);
    fn(h);
    h.updatedAt = nowIso();
    this.store.saveHuddle(slug, h);
    this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
    return h;
  }

  private updateP(slug: string, hid: string, handle: string, patch: Partial<HuddleParticipant>): void {
    if (!this.store.getHuddle(slug, hid)) return;
    this.update(slug, hid, (h) => {
      const p = h.participants.find((x) => x.handle === handle);
      if (p) Object.assign(p, patch);
    });
  }

  private append(slug: string, hid: string, from: string, text: string, kind: HuddleMessageKind, known: string[]): HuddleMessage {
    let seq = 0;
    this.update(slug, hid, (h) => {
      seq = h.seq = h.seq + 1;
      // The sender has seen everything up to its own message.
      const p = h.participants.find((x) => x.handle === from);
      if (p && p.cursor === seq - 1) p.cursor = seq;
    });
    const mentions = kind === "system" ? [] : parseMentions(text).filter((m) => m === "all" || known.includes(m));
    const m: HuddleMessage = { id: `m_${newId()}`, seq, ts: nowIso(), from, text, mentions, kind };
    this.store.appendHuddleMessage(slug, hid, m);
    this.bus.emit({ type: "huddle.message", profile: slug, huddleId: hid, message: m });
    return m;
  }

  private system(slug: string, hid: string, text: string): HuddleMessage {
    return this.append(slug, hid, "system", text, "system", []);
  }

  /** Start a huddle on a ticket from a roster (the user pressed Start on a proposed roster, or made one). */
  create(slug: string, hostId: string, roster: RosterEntry[], opts: { maxParticipants?: number } = {}): Huddle {
    const host = this.store.getTicket(slug, hostId);
    if (!host) throw new HuddleError(404, `ticket ${hostId} not found`);
    if (host.error?.startsWith("corrupt")) throw new HuddleError(409, `ticket ${hostId} file is corrupt`);
    const max = Math.max(2, Math.min(32, Math.round(opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)));
    const open = this.store.listHuddles(slug).find((h) => h.hostTicket === hostId && h.status !== "closed");
    if (open) throw new HuddleError(409, `ticket ${hostId} already has an open huddle (${open.id}); close it first`);
    const presets = this.presetMap(slug);
    const err = rosterError(roster, max, [...presets.keys()]);
    if (err) throw new HuddleError(400, err);
    const at = nowIso();
    const main = presets.get(MAIN_PRESET)!;
    const base = { prompt: "", focus: undefined, sessionId: null, status: "idle" as const, cursor: 0, joinedAt: at, workspace: "shared" as const, preset: null };
    const h: Huddle = {
      id: `h_${newId()}`, hostTicket: hostId, status: "live", maxParticipants: max, findings: [], invited: [], seq: 0, createdAt: at, updatedAt: at,
      participants: [
        { ...base, handle: USER_HANDLE, role: "User", model: null, mode: "monitor", lead: true, canEdit: false, kind: "human" },
        {
          ...base, handle: MAIN_HANDLE, role: main.role, preset: MAIN_PRESET, prompt: main.prompt, model: null, mode: main.mode, lead: true, canEdit: true,
          kind: "ticket-main", ticketId: hostId,
        },
      ],
    };
    const agents: HuddleParticipant[] = [];
    for (const e of roster) {
      const ps = this.expand(e, h.participants.map((p) => p.handle), presets);
      h.participants.push(...ps);
      agents.push(...ps);
    }
    this.store.saveHuddle(slug, h);
    this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
    this.system(slug, h.id, `Huddle started on ticket ${hostId} "${host.title}" with ${agents.map((p) => `@${p.handle} (${p.role})`).join(", ")}. @main coordinates.`);
    for (const p of agents) this.kickoff(slug, h.id, p.handle);
    return this.get(slug, h.id);
  }

  /** Participants made from one roster entry, with handles not in `taken`. */
  private expand(e: RosterEntry, taken: string[], presets: Map<string, HuddlePreset>): HuddleParticipant[] {
    const preset = e.preset ? presets.get(e.preset.trim()) : undefined;
    const count = e.count ?? 1;
    const base = handleBase(e.handle?.trim() || e.preset?.trim() || e.role!);
    const used = new Set([...taken, ...RESERVED_HANDLES]);
    const out: HuddleParticipant[] = [];
    for (let i = 0, n = 1; i < count; i++) {
      let handle = base;
      if (count > 1 || used.has(handle)) {
        while (used.has(`${base}-${n}`)) n++;
        handle = `${base}-${n}`;
      }
      used.add(handle);
      const workspace = e.workspace ?? preset?.workspace ?? "shared";
      out.push({
        handle, role: e.role?.trim() || preset?.role || base, preset: e.preset?.trim() ?? null,
        prompt: [preset?.prompt, e.prompt?.trim()].filter(Boolean).join("\n\n") || `Help with the ticket as ${e.role}.`,
        ...(e.focus?.trim() ? { focus: e.focus.trim() } : {}),
        model: e.model?.trim() || preset?.model || null, mode: e.mode ?? preset?.mode ?? "tagged", lead: e.lead ?? preset?.lead ?? false,
        // Only an agent in its own worktree may edit: the shared worktree is the coordinator's.
        canEdit: workspace === "own" && (e.canEdit ?? preset?.canEdit ?? true), workspace, sessionId: null, status: "idle", kind: "agent", cursor: 0, joinedAt: nowIso(), token: newId() + newId(),
      });
    }
    return out;
  }

  private nonHuman(h: Huddle): number {
    return h.participants.filter((p) => p.kind !== "human").length;
  }

  private assertOpen(h: Huddle) {
    if (h.status === "closed") throw new HuddleError(409, `huddle ${h.id} is closed (read-only)`);
  }

  /** Add participants (the user, the coordinator or a lead); refused once maxParticipants is reached. */
  addParticipants(slug: string, hid: string, by: HuddleParticipant, e: RosterEntry): HuddleParticipant[] {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!canManage(h, by)) throw new HuddleError(403, `only a lead or @main can add participants; ask them (or the user) in the huddle`);
    const presets = this.presetMap(slug);
    const err = rosterEntryError(e, "", [...presets.keys()]);
    if (err) throw new HuddleError(400, err);
    const want = e.count ?? 1;
    const room = h.maxParticipants - this.nonHuman(h);
    if (want > room) {
      throw new HuddleError(409, `the huddle is full: ${this.nonHuman(h)} of ${h.maxParticipants} participants${room > 0 ? `, room for ${room} more` : ""}. ` +
        "Don't work around the limit: ask the user (tag @you) to raise it or stop someone.");
    }
    const added = this.expand(e, h.participants.map((p) => p.handle), presets);
    this.update(slug, hid, (x) => {
      x.participants.push(...added);
    });
    this.system(slug, hid, `@${by.handle} added ${added.map((p) => `@${p.handle} (${p.role}${p.focus ? `: ${p.focus}` : ""})`).join(", ")}.`);
    if (h.status === "live") for (const p of added) this.kickoff(slug, hid, p.handle);
    return added;
  }

  /** Invite another ticket's own session (same board), e.g. as @api-main. */
  invite(slug: string, hid: string, by: HuddleParticipant, ticketId: string, handle?: string): HuddleParticipant {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (by.kind !== "human" && !isCoordinator(h, by)) throw new HuddleError(403, "only the user or @main can invite tickets");
    const t = this.store.getTicket(slug, ticketId);
    if (!t) throw new HuddleError(404, `ticket ${ticketId} not found`);
    if (h.participants.some((p) => p.ticketId === ticketId)) throw new HuddleError(409, `ticket ${ticketId} is already in this huddle`);
    if (this.nonHuman(h) >= h.maxParticipants) throw new HuddleError(409, `the huddle is full (${h.maxParticipants} participants)`);
    const base = handleBase(handle?.trim() || `${t.planKey || t.title.split(/\s+/)[0] || "ticket"}-main`);
    const taken = new Set([...h.participants.map((p) => p.handle), ...RESERVED_HANDLES]);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    const p: HuddleParticipant = {
      handle: name, role: `Ticket ${t.id} "${t.title}"`, preset: null, prompt: "", model: null, mode: "tagged", lead: false, canEdit: false,
      workspace: "shared", sessionId: null, status: "idle", kind: "ticket-main", ticketId, cursor: h.seq, joinedAt: nowIso(),
    };
    this.update(slug, hid, (x) => {
      x.participants.push(p);
      x.invited.push(ticketId);
    });
    this.system(slug, hid, `@${by.handle} invited ticket ${t.id} "${t.title}" as @${name}.`);
    return p;
  }

  setMode(slug: string, hid: string, by: HuddleParticipant, handle: string, mode: HuddleMode): HuddleParticipant {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (by.kind !== "human" && by.handle !== handle) throw new HuddleError(403, "you can only change your own mode");
    const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
    if (!p) throw new HuddleError(404, `no participant @${handle}`);
    if (mode !== "tagged" && mode !== "monitor") throw new HuddleError(400, "mode must be tagged or monitor");
    if (p.mode === mode) return p;
    this.updateP(slug, hid, handle, { mode });
    // A monitor session no longer needs to stay open between turns.
    if (mode === "tagged") this.runs.get(this.key(slug, hid, handle))?.handle?.endWhenIdle();
    this.system(slug, hid, `@${handle} switched to ${mode} mode${by.handle !== handle ? ` (by @${by.handle})` : ""}.`);
    return { ...p, mode };
  }

  /** The pinned findings list: leads and the coordinator add and resolve; everyone can list. */
  findings(slug: string, hid: string, by: HuddleParticipant, action: "add" | "resolve" | "list", arg: { text?: string; id?: string } = {}): HuddleFinding[] {
    const h = this.get(slug, hid);
    if (action === "list") return h.findings;
    this.assertOpen(h);
    if (!canManage(h, by)) throw new HuddleError(403, "only a lead or @main can change the findings list; post your finding to your lead instead");
    if (action === "add") {
      const text = arg.text?.trim();
      if (!text) throw new HuddleError(400, "text is required");
      const f: HuddleFinding = { id: `f${h.findings.length + 1}`, text, by: by.handle, status: "open", resolvedBy: null, at: nowIso() };
      this.update(slug, hid, (x) => void x.findings.push(f));
      this.system(slug, hid, `@${by.handle} pinned finding ${f.id}: ${text}`);
    } else if (action === "resolve") {
      const f = h.findings.find((x) => x.id === arg.id);
      if (!f) throw new HuddleError(404, `no finding ${arg.id}`);
      if (f.status === "resolved") return h.findings;
      this.update(slug, hid, (x) => {
        const g = x.findings.find((y) => y.id === arg.id)!;
        Object.assign(g, { status: "resolved", resolvedBy: by.handle });
      });
      this.system(slug, hid, `@${by.handle} resolved finding ${f.id}.`);
    } else throw new HuddleError(400, "action must be add, resolve or list");
    return this.get(slug, hid).findings;
  }

  /** Post a message as `by` (the daemon decided who that is) and route it. */
  post(slug: string, hid: string, by: HuddleParticipant, text: string, kind: HuddleMessageKind = "message"): HuddleMessage {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    if (!text.trim()) throw new HuddleError(400, "text is required");
    if (kind !== "message" && kind !== "finding") throw new HuddleError(400, "kind must be message or finding");
    if (by.status === "stopped" && by.kind !== "human") throw new HuddleError(409, `@${by.handle} was stopped by the user`);
    const m = this.append(slug, hid, by.handle, text.trim(), kind, h.participants.map((p) => p.handle));
    // Stopped: the log keeps it; nothing is woken until the user resumes.
    if (h.status === "live") this.route(slug, hid, m);
    return m;
  }

  private route(slug: string, hid: string, m: HuddleMessage) {
    const h = this.get(slug, hid);
    for (const p of h.participants) {
      if (p.kind === "human" || p.handle === m.from || p.status === "stopped") continue;
      const mentioned = m.mentions.includes(p.handle) || m.mentions.includes("all");
      if (mentioned || p.mode === "monitor") this.deliver(slug, h, p, mentioned);
    }
  }

  /**
   * Unread messages for a participant as one digest, and moves its cursor past them. Null when there is nothing
   * to act on (only system messages, unless withSystem). undo: put the cursor back (the digest never arrived).
   */
  private takeUnread(slug: string, hid: string, handle: string, withSystem = false): { digest: string; undo: () => void } | null {
    const h = this.get(slug, hid);
    const p = h.participants.find((x) => x.handle === handle);
    if (!p) return null;
    const unread = this.store.readHuddleMessages(slug, hid).filter((m) => m.seq > p.cursor && m.from !== handle);
    const prev = p.cursor;
    if (p.cursor !== h.seq) this.updateP(slug, hid, handle, { cursor: h.seq });
    if (!unread.length || (!withSystem && !unread.some((m) => m.kind !== "system"))) return null;
    const shown = unread.slice(-DIGEST_MAX);
    return { digest: huddleDigest(shown, unread.length - shown.length), undo: () => this.updateP(slug, hid, handle, { cursor: prev }) };
  }

  private deliver(slug: string, h: Huddle, p: HuddleParticipant, mentioned: boolean) {
    if (p.kind === "ticket-main") {
      // Monitor: one message with everything once its current run is over, not a steer per message.
      if (!mentioned && p.ticketId && this.board.isRunning(slug, p.ticketId)) {
        this.mainPending.add(this.key(slug, h.id, p.handle));
        return;
      }
      return this.deliverNow(slug, h.id, p.handle);
    }
    const run = this.runs.get(this.key(slug, h.id, p.handle));
    if (run) {
      // Mid-turn: a mention steers it now; for a monitor the rest waits for the turn boundary.
      if (!mentioned && !run.idle) {
        run.pending = true;
        return;
      }
      return this.deliverNow(slug, h.id, p.handle);
    }
    this.deliverNow(slug, h.id, p.handle);
  }

  /** Hand the participant everything it hasn't read: into its live run, a ticket chat message, or a new run. */
  private deliverNow(slug: string, hid: string, handle: string) {
    const h = this.store.getHuddle(slug, hid);
    const p = h?.participants.find((x) => x.handle === handle);
    if (!h || !p || h.status !== "live" || p.status === "stopped" || this.shuttingDown) return;
    if (p.kind === "ticket-main") {
      const u = p.ticketId ? this.takeUnread(slug, hid, handle) : null;
      if (!u) return;
      this.board.chat(slug, p.ticketId!, huddleMainPrompt(h, p, u.digest), { peer: true }).catch((e) => {
        u.undo();
        this.system(slug, hid, `Couldn't reach @${handle}: ${(e as Error).message}`);
      });
      return;
    }
    const run = this.runs.get(this.key(slug, hid, handle));
    if (run) {
      if (run.stopRequested) return;
      // Still starting (worktree, setup): it gets them at its first turn boundary.
      if (!run.handle) {
        run.pending = true;
        return;
      }
      run.pending = false;
      const u = this.takeUnread(slug, hid, handle);
      if (!u) return;
      if (run.handle?.send(huddleAgentPrompt("wake", p, u.digest))) {
        if (run.idle) this.updateP(slug, hid, handle, { status: "working" });
        run.idle = false;
      } else {
        // Input is closing (the run is finishing): a new run picks them up.
        u.undo();
        run.again = true;
      }
      return;
    }
    const u = this.takeUnread(slug, hid, handle);
    if (u) this.runAgent(slug, hid, handle, huddleAgentPrompt("wake", p, u.digest));
  }

  /** An agent's first run: start on its job with what was said so far. */
  private kickoff(slug: string, hid: string, handle: string) {
    const p = this.get(slug, hid).participants.find((x) => x.handle === handle)!;
    this.runAgent(slug, hid, handle, huddleAgentPrompt("start", p, this.takeUnread(slug, hid, handle, true)?.digest ?? ""));
  }

  private runAgent(slug: string, hid: string, handle: string, input: string) {
    const key = this.key(slug, hid, handle);
    if (this.runs.has(key) || this.shuttingDown) return;
    const run: AgentRun = { handle: null, promise: Promise.resolve(), idle: false, pending: false, again: false, stopRequested: false };
    this.runs.set(key, run);
    this.updateP(slug, hid, handle, { status: "working", error: null, interrupted: false });
    run.promise = this.executeAgent(slug, hid, handle, run, input)
      .catch((e) => {
        console.error(`huddle ${slug}/${hid} @${handle} crashed`, e);
        this.updateP(slug, hid, handle, { status: "failed", error: String((e as Error)?.message ?? e) });
      })
      .finally(() => {
        this.runs.delete(key);
        if (this.shuttingDown) return;
        // Emit with running: false now that the run is gone.
        if (this.store.getHuddle(slug, hid)) this.update(slug, hid, () => {});
        if ((run.again || run.pending) && !run.stopRequested) this.deliverNow(slug, hid, handle);
      });
  }

  /** Where an agent works: the host ticket's worktree, or (workspace own) a worktree of its own off the host's branch. */
  private async workspace(slug: string, h: Huddle, p: HuddleParticipant): Promise<string> {
    const host = await this.board.ensureSession(slug, h.hostTicket);
    if (p.workspace === "shared") return host.dir;
    const profile = this.store.getProfile(slug)!;
    if (!(await isGitRepo(profile.path))) throw new Error("workspace own needs a git repository");
    if (p.worktree && existsSync(p.worktree)) return p.worktree;
    const t = this.store.getTicket(slug, h.hostTicket)!;
    // Not in the board's worktree folder itself, so the startup sweep (one folder per ticket id) leaves it alone.
    const dir = join(dirname(worktreeDir(profile, h.hostTicket)), `${h.hostTicket}.huddle`, p.handle);
    const branch = p.branch ?? `ck/${h.hostTicket}-${p.handle}`;
    await addWorktree(profile.path, dir, branch, t.branch ?? profile.baseBranch);
    this.updateP(slug, h.id, p.handle, { worktree: dir, branch });
    return dir;
  }

  private async executeAgent(slug: string, hid: string, handle: string, run: AgentRun, input: string): Promise<void> {
    let h = this.get(slug, hid);
    let p = h.participants.find((x) => x.handle === handle)!;
    const host = this.store.getTicket(slug, h.hostTicket);
    if (!host) throw new Error(`host ticket ${h.hostTicket} not found`);
    const dir = await this.workspace(slug, h, p);
    if (run.stopRequested || this.shuttingDown) return;
    h = this.get(slug, hid);
    p = h.participants.find((x) => x.handle === handle)!;
    const profile = this.store.getProfile(slug)!;
    const sessionId = p.sessionId ?? crypto.randomUUID();
    const resume = !!p.sessionStarted && this.sessionExists(sessionId);
    if (!p.sessionId) this.updateP(slug, hid, handle, { sessionId });
    const outputDir = this.store.huddleOutputsDir(slug, h.hostTicket, handle);
    const system = huddleAgentSystemPrompt(h, p, host as Ticket, outputDir, dir);
    const args = [
      ...buildArgs(sessionId, resume, p.model ?? profile.model, "bypassPermissions", mcpConfig(), system),
      ...(p.canEdit ? [] : ["--disallowedTools", NO_EDIT_TOOLS]),
    ];
    let lastWrite = 0;
    let started = resume;
    run.handle = startRun({
      bin: this.opts.claudeBin, cwd: dir, args, input,
      // Huddle agents have no board slot: CKANBAN_TICKET is the host (its board and outputs), CKANBAN_HUDDLE_AGENT who they are.
      env: { CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${h.hostTicket}`, [HUDDLE_AGENT_ENV]: `${hid}/${handle}/${p.token}` },
      idleMs: p.mode === "monitor" ? this.opts.idleMs ?? MONITOR_IDLE_MS : undefined,
      onEvent: (ev) => {
        if (ev?.type === "stream_event" || this.shuttingDown) return;
        if (ev?.type === "result") {
          run.idle = true;
          this.updateP(slug, hid, handle, { status: "idle" });
          // Turn boundary: a monitor gets what came in while it worked.
          if (run.pending) queueMicrotask(() => this.deliverNow(slug, hid, handle));
          return;
        }
        // Saved at once: a restart may cut the run off before it ends, and the next run must resume this session.
        if (ev?.type === "system" && ev.subtype === "init" && !started) {
          started = true;
          this.updateP(slug, hid, handle, { sessionStarted: true });
        }
        if (run.idle && (ev?.type === "assistant" || (ev?.type === "system" && ev.subtype === "init"))) {
          run.idle = false;
          this.updateP(slug, hid, handle, { status: "working" });
        }
        const s = summarizeEvent(ev);
        const now = Date.now();
        if (s && now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          this.updateP(slug, hid, handle, { lastActivity: s });
        }
      },
    });
    const out = await run.handle.done;
    if (this.shuttingDown) return;
    started ||= this.sessionExists(sessionId);
    if (!this.store.getHuddle(slug, hid)) return;
    if (run.stopRequested || run.handle.stopped) return this.updateP(slug, hid, handle, { sessionStarted: started, status: "stopped" });
    if (out.code !== 0) {
      const error = out.stderr.trim().split("\n").slice(-3).join("\n") || `claude exited with code ${out.code}`;
      this.updateP(slug, hid, handle, { sessionStarted: started, status: "failed", error });
      this.system(slug, hid, `@${handle}'s run failed: ${error}`);
      return;
    }
    this.updateP(slug, hid, handle, { sessionStarted: started, status: "idle" });
  }

  private stopParticipantRun(slug: string, h: Huddle, p: HuddleParticipant) {
    const run = this.runs.get(this.key(slug, h.id, p.handle));
    if (run) {
      run.stopRequested = true;
      run.handle?.stop();
    }
    this.mainPending.delete(this.key(slug, h.id, p.handle));
    // A ticket's session: stop its run too (the user's one Stop stops everyone).
    if (p.kind === "ticket-main" && p.ticketId) this.board.stop(slug, p.ticketId);
  }

  /** The user stops one participant: its run ends and nothing wakes it until the huddle is resumed. */
  stopParticipant(slug: string, hid: string, handle: string): void {
    const h = this.get(slug, hid);
    const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
    if (!p) throw new HuddleError(404, `no participant @${handle}`);
    this.stopParticipantRun(slug, h, p);
    this.updateP(slug, hid, handle, { status: "stopped" });
    if (h.status !== "closed") this.system(slug, hid, `@${handle} was stopped by @you.`);
  }

  /** Stop all: every participant's run ends and the huddle stops routing until resumed. */
  stopAll(slug: string, hid: string): Huddle {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
    this.update(slug, hid, (x) => {
      x.status = "stopped";
      for (const p of x.participants) if (p.kind !== "human") p.status = "stopped";
    });
    this.system(slug, hid, "Huddle stopped by @you: every run was stopped.");
    return this.get(slug, hid);
  }

  /** Resume routing; stopped participants wake again when tagged (or, in monitor mode, on new messages). */
  resume(slug: string, hid: string): Huddle {
    const h = this.get(slug, hid);
    this.assertOpen(h);
    this.update(slug, hid, (x) => {
      x.status = "live";
      for (const p of x.participants) if (p.status === "stopped") p.status = "idle";
    });
    if (h.status !== "live") this.system(slug, hid, "Huddle resumed by @you.");
    return this.get(slug, hid);
  }

  /** Only the user closes a huddle: every run stops and the history stays, read-only. */
  close(slug: string, hid: string): Huddle {
    const h = this.get(slug, hid);
    if (h.status === "closed") return h;
    for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
    this.system(slug, hid, "Huddle closed by @you. The history stays, read-only.");
    return this.update(slug, hid, (x) => {
      x.status = "closed";
      x.closedAt = nowIso();
      for (const p of x.participants) if (p.kind !== "human" && p.status === "working") p.status = "stopped";
    });
  }

  /** The host ticket was deleted: its huddles close. */
  closeForTicket(slug: string, ticketId: string): void {
    for (const h of this.store.listHuddles(slug)) if (h.hostTicket === ticketId && h.status !== "closed") this.close(slug, h.id);
  }

  /** Daemon exiting: agents mid-turn are marked so recover() resumes them; every agent run is killed. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runs = [...this.runs.entries()];
    for (const [key, run] of runs) {
      const [slug, hid, handle] = key.split("/");
      if (!run.idle && !run.stopRequested) this.updateP(slug, hid, handle, { interrupted: true });
      run.stopRequested = true;
      run.handle?.stop();
    }
    await Promise.race([Promise.all(runs.map(([, r]) => r.promise)), Bun.sleep(6000)]);
  }

  /** After a daemon restart: agents cut off mid-turn carry on; the rest wait to be woken as usual. */
  recover(): void {
    for (const profile of this.store.listProfiles()) {
      for (const h of this.store.listHuddles(profile.slug)) {
        if (h.status === "closed") continue;
        for (const p of h.participants) {
          if (p.kind !== "agent") continue;
          const cut = p.interrupted || p.status === "working";
          if (h.status === "live" && cut && p.status !== "stopped") {
            const digest = this.takeUnread(profile.slug, h.id, p.handle, true)?.digest ?? "";
            this.runAgent(profile.slug, h.id, p.handle, huddleAgentPrompt(p.sessionStarted ? "interrupted" : "start", p, digest));
          } else if (p.status === "working" || p.interrupted) this.updateP(profile.slug, h.id, p.handle, { status: "idle", interrupted: false });
        }
      }
    }
  }

  async whenIdle(): Promise<void> {
    while (this.runs.size) await Promise.all([...this.runs.values()].map((r) => r.promise));
  }
}
