/** Huddle helpers on the fields used here of api.ts's types (kept DOM-free so the root typecheck and tests can import it). */

interface HuddleLike { hostTicket: string; status: string; createdAt: string }
interface ParticipantLike {
  handle: string;
  role: string;
  kind: string;
  mode: string;
  status: string;
  lastActivity?: string | null;
  error?: string | null;
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

/** The `@partial` being typed right before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[^\w@./-])@([\w-]*)$/);
  return m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

export const DEFAULT_MAX = 8;

/** A roster being edited before Start: agent rows, tickets to invite and the coordinator's mode. */
export interface Draft<E extends EntryLike = EntryLike, Mode extends string = string> {
  rows: (E & { key: string })[];
  invites: string[];
  mainMode: Mode | null;
}

let nextKey = 0;
export const rowKey = () => `r${++nextKey}`;

export function rosterDraft<E extends EntryLike, Mode extends string = string>(roster: E[]): Draft<E, Mode> {
  return { rows: roster.map((e) => ({ ...e, key: rowKey() })), invites: [], mainMode: null };
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
  state: "live" | "stopped" | "closed" | "guest";
}

/**
 * What a card says about huddles: its own open huddle (`Huddle · 8 · 3 working`), else an open one it was
 * invited to (`in huddle of k2pm`), else its newest closed one (`Huddle · closed · 31 msgs`).
 */
export function cardHuddleBadge(list: BoardHuddleLike[], ticketId: string): CardHuddleBadge | null {
  const open = list.find((h) => h.hostTicket === ticketId && h.status !== "closed");
  if (open) {
    const agents = open.participants.filter((p) => p.kind !== "human");
    const working = agents.filter((p) => p.status === "working").length;
    const live = open.status === "live";
    return {
      huddleId: open.id, openTicket: ticketId, state: live ? "live" : "stopped",
      label: `Huddle · ${agents.length} · ${live ? `${working} working` : "stopped"}`,
      title: `${agents.length} in this ticket's huddle${live ? `, ${working} working` : ", stopped"}. Click to open it.`,
    };
  }
  const guest = list.find((h) => h.status !== "closed" && h.hostTicket !== ticketId && guestTickets(h).includes(ticketId));
  if (guest) {
    return {
      huddleId: guest.id, openTicket: guest.hostTicket, state: "guest",
      label: `in huddle of ${shortTicketId(guest.hostTicket)}`,
      title: `Invited to the huddle of ${guest.hostTitle ? `"${guest.hostTitle}"` : guest.hostTicket}. Click to open it.`,
    };
  }
  const closed = pickHuddle(list, ticketId);
  if (closed) {
    return {
      huddleId: closed.id, openTicket: ticketId, state: "closed",
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
