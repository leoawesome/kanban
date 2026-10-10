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
