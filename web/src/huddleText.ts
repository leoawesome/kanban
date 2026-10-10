/** Huddle helpers on the fields used here of api.ts's types (kept DOM-free so the root typecheck and tests can import it). */

interface HuddleLike { hostTicket: string; status: string; createdAt: string }
interface ParticipantLike {
  handle: string;
  role: string;
  kind: string;
  mode: string;
  status: string;
  statusReason?: string | null;
  lastActivity?: string | null;
  error?: string | null;
  costUsd?: number;
}
interface EntryLike { preset?: string; role?: string; count?: number; handle?: string }

/** The huddle a ticket's Huddle tab shows: its open one, else the newest closed one (history). */
export function pickHuddle<H extends HuddleLike>(list: H[], ticketId: string): H | null {
  const mine = list.filter((h) => h.hostTicket === ticketId);
  return mine.find((h) => h.status !== "closed") ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** Messages by seq, without duplicates (live events and fetched pages overlap). */
export function mergeMessages<M extends { seq: number }>(a: M[], b: M[]): M[] {
  const bySeq = new Map<number, M>();
  for (const m of [...a, ...b]) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** Avatar letters: first letter, plus the number of a numbered copy (qa-2: Q2). */
export function handleInitials(handle: string): string {
  const n = handle.match(/-(\d+)$/)?.[1];
  return `${(handle[0] ?? "?").toUpperCase()}${n ?? ""}`.slice(0, 3);
}

/** One line on what a participant is doing, for the roster. `closed`: the huddle is over, nobody watches. */
export function participantActivity(p: ParticipantLike, closed = false): string {
  if (p.kind === "human") return "you";
  if (p.status === "stopped") return "stopped";
  if (p.status === "failed") return p.error ? `failed: ${p.error.split("\n")[0]}` : "failed";
  if (p.status === "done" || p.status === "blocked") return p.statusReason ? `${p.status}: ${p.statusReason}` : p.status;
  if (p.status === "working") return p.lastActivity || "working…";
  return p.mode === "monitor" && !closed ? "watching" : "idle";
}

/** @ candidates for the composer: @main first, @all, then the rest (never @you). */
export function mentionCandidates(h: { participants: ParticipantLike[] }): { handle: string; label: string }[] {
  const ps = h.participants.filter((p) => p.kind !== "human");
  const main = ps.find((p) => p.handle === "main");
  return [
    ...(main ? [{ handle: "main", label: `coordinator · ${participantActivity(main)}` }] : []),
    { handle: "all", label: "everyone" },
    ...ps.filter((p) => p.handle !== "main").map((p) => ({ handle: p.handle, label: `${p.role} · ${participantActivity(p)}` })),
  ];
}

/** A message that needs the user: it tags @you (brake and close-request lines too) after `since` (see the daemon's isForYou). */
export const isForYou = (m: { seq: number; from: string; mentions: string[] }, since: number) =>
  m.seq > since && m.from !== "you" && m.mentions.includes("you");

/** Handles a draft tags (known handles and @all), in order, without duplicates. */
export function draftTags(text: string, handles: string[]): string[] {
  const known = new Set([...handles, "all"]);
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w@./-])@([a-z0-9][a-z0-9_-]*)/gi)) {
    const h = m[2].toLowerCase();
    if (known.has(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/** Who an untagged post wakes: monitors that are not stopped, blocked or done (the daemon's wakes()). */
export const untaggedWakes = (h: { participants: ParticipantLike[] }) =>
  h.participants.filter((p) => p.kind !== "human" && p.mode === "monitor" && !["stopped", "blocked", "done"].includes(p.status)).map((p) => p.handle);

/** The composer's warning for a post without a tag, or null when it tags someone (or is empty). */
export function untaggedHint(text: string, h: { participants: ParticipantLike[] }): string | null {
  if (!text.trim() || draftTags(text, h.participants.map((p) => p.handle)).length) return null;
  const mon = untaggedWakes(h);
  if (!mon.length) return "No @tag: nobody wakes for this. Tag @main, @all or a handle.";
  return `No @tag: only ${mon.map((x) => `@${x}`).join(", ")} (monitor) will see this. Nobody else wakes.`;
}

/** The `@partial` being typed right before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[^\w@./-])@([\w-]*)$/);
  return m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

export const DEFAULT_MAX = 8;
/** A huddle's default spending limit (the daemon's DEFAULT_MAX_COST_USD). */
export const DEFAULT_BUDGET = 20;

/** A roster being edited before Start: agent rows, tickets to invite and the coordinator's mode. */
export interface Draft<E extends EntryLike = EntryLike, Mode extends string = string> {
  rows: (E & { key: string })[];
  invites: string[];
  mainMode: Mode | null;
  /** Spending limit in USD; the huddle stops when it is spent. */
  maxCostUsd: number;
}

let nextKey = 0;
export const rowKey = () => `r${++nextKey}`;

export function rosterDraft<E extends EntryLike, Mode extends string = string>(roster: E[]): Draft<E, Mode> {
  return { rows: roster.map((e) => ({ ...e, key: rowKey() })), invites: [], mainMode: null, maxCostUsd: DEFAULT_BUDGET };
}

/** Everyone who would join, @main included (the user doesn't count). */
export const draftSize = (d: Draft<any, any>) => 1 + d.rows.reduce((n, r) => n + (r.count ?? 1), 0) + d.invites.length;

export const handleBase = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "agent";
export const rowHandle = (r: EntryLike) => handleBase(r.handle?.trim() || r.preset?.trim() || r.role || "agent");

/** What's wrong with a draft before Start, or null. */
export function draftError(d: Draft<any, any>, max = DEFAULT_MAX): string | null {
  if (!d.rows.length) return "Add at least one role.";
  if (d.rows.some((r) => !r.preset && !r.role?.trim())) return "Name each custom role.";
  if (draftSize(d) > max) return `That's ${draftSize(d)} participants with @main, over the limit of ${max}.`;
  if (!(d.maxCostUsd > 0)) return "Set a budget above $0.";
  return null;
}

// ---- Board: card badges and the dock's Huddles list ----

interface BoardHuddleLike extends HuddleLike {
  id: string;
  hostTitle?: string | null;
  seq: number;
  updatedAt: string;
  invited?: string[];
  participants: (ParticipantLike & { ticketId?: string | null })[];
  stopReason?: "budget" | "messages" | "loop" | null;
  maxCostUsd?: number;
  quiet?: boolean;
  idleSince?: string | null;
  forYou?: number;
  findings?: { status: string }[];
}

/** $20, $12.50. */
export const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** How long since `iso`, short: "<1m", "12m", "3h", "2d". */
export function idleFor(iso: string, now = Date.now()): string {
  const m = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** Why a huddle stopped by itself, short: "paused: $20 budget". Null for a running huddle or a plain Stop. */
export function brakeLabel(h: { status: string; stopReason?: BoardHuddleLike["stopReason"]; maxCostUsd?: number }): string | null {
  if (h.status !== "stopped" || !h.stopReason) return null;
  if (h.stopReason === "budget") return `paused: ${dollars(h.maxCostUsd ?? DEFAULT_BUDGET)} budget`;
  return h.stopReason === "messages" ? "paused: message limit" : "paused: waiting for you";
}

/** The quiet state, short: "idle 12m · 0 open". Null unless the huddle is quiet. */
export function quietLabel(h: BoardHuddleLike, now = Date.now()): string | null {
  if (h.status !== "live" || !h.quiet) return null;
  const open = (h.findings ?? []).filter((f) => f.status === "open").length;
  return `idle ${idleFor(h.idleSince ?? h.updatedAt, now)} · ${open} open`;
}

/** Tickets other than the host that take part (invited ticket sessions). */
export function guestTickets(h: BoardHuddleLike): string[] {
  const ids = new Set(h.invited ?? []);
  for (const p of h.participants) if (p.ticketId) ids.add(p.ticketId);
  ids.delete(h.hostTicket);
  return [...ids];
}

/** The last part of a ticket id (t_20261009_k2pm: k2pm). */
export const shortTicketId = (id: string) => id.split("_").pop() || id;

export interface CardHuddleBadge {
  huddleId: string;
  /** The ticket whose Huddle tab the badge opens (the host's, for an invited ticket). */
  openTicket: string;
  label: string;
  title: string;
  /** brake: stopped by a brake (err tone); quiet: live with nothing left to do (ok tone). */
  state: "live" | "stopped" | "brake" | "quiet" | "closed" | "guest";
  /** Messages waiting for the user (the accent "N for you" pill). */
  forYou: number;
  /** Agents whose run failed (err tone). */
  failed: number;
}

/**
 * What a card says about huddles: its own open huddle (`Huddle · 8 · 3 working`), else an open one it was
 * invited to (`in huddle of k2pm`), else its newest closed one (`Huddle · closed · 31 msgs`).
 */
export function cardHuddleBadge(list: BoardHuddleLike[], ticketId: string, now = Date.now()): CardHuddleBadge | null {
  const open = list.find((h) => h.hostTicket === ticketId && h.status !== "closed");
  if (open) {
    const agents = open.participants.filter((p) => p.kind !== "human");
    const working = agents.filter((p) => p.status === "working").length;
    const failed = agents.filter((p) => p.status === "failed").length;
    const forYou = open.forYou ?? 0;
    const live = open.status === "live";
    const brake = brakeLabel(open);
    const quiet = quietLabel(open, now);
    const you = forYou ? ` ${forYou} ${forYou === 1 ? "message needs" : "messages need"} you.` : "";
    const base = { huddleId: open.id, openTicket: ticketId, forYou, failed };
    if (brake) return { ...base, state: "brake", label: `Huddle · ${brake}`, title: `This ticket's huddle is ${brake}.${you} Click to open it.` };
    if (quiet) return { ...base, state: "quiet", label: `Huddle · ${agents.length} · ${quiet}`, title: `This ticket's huddle is quiet: nobody working, nothing open. Check the result, then close it.${you}` };
    return {
      ...base, state: live ? "live" : "stopped",
      label: `Huddle · ${agents.length} · ${live ? `${working} working` : "stopped"}`,
      title: `${agents.length} in this ticket's huddle${live ? `, ${working} working` : ", stopped"}${failed ? `, ${failed} failed` : ""}.${you} Click to open it.`,
    };
  }
  const guest = list.find((h) => h.status !== "closed" && h.hostTicket !== ticketId && guestTickets(h).includes(ticketId));
  if (guest) {
    return {
      huddleId: guest.id, openTicket: guest.hostTicket, state: "guest", forYou: 0, failed: 0,
      label: `in huddle of ${shortTicketId(guest.hostTicket)}`,
      title: `Invited to the huddle of ${guest.hostTitle ? `"${guest.hostTitle}"` : guest.hostTicket}. Click to open it.`,
    };
  }
  const closed = pickHuddle(list, ticketId);
  if (closed) {
    return {
      huddleId: closed.id, openTicket: ticketId, state: "closed", forYou: 0, failed: 0,
      label: `Huddle · closed · ${closed.seq} ${closed.seq === 1 ? "msg" : "msgs"}`,
      title: "This ticket's huddle is closed. Click to read it.",
    };
  }
  return null;
}

/** The dock's list: live first, then stopped, then closed; newest activity first within each. `limit` caps the closed ones. */
export function sortHuddles<H extends BoardHuddleLike>(list: H[], limit = 20): H[] {
  const rank = (h: H) => (h.status === "live" ? 0 : h.status === "stopped" ? 1 : 2);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  const open = sorted.filter((h) => h.status !== "closed");
  return [...open, ...sorted.filter((h) => h.status === "closed").slice(0, limit)];
}

/** Insert or replace a huddle by id (huddle.updated events). */
export function upsertHuddle<H extends { id: string }>(list: H[], h: H): H[] {
  const i = list.findIndex((x) => x.id === h.id);
  if (i < 0) return [...list, h];
  const next = list.slice();
  next[i] = h;
  return next;
}
