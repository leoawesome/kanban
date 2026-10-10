/** Header pill and filter counts on ticket and huddle fields (no imports from api.ts, so tests can load this file). */

interface RunLike { running?: boolean; holdsSlot?: boolean }
interface HuddleLike { status: string; participants: { kind: string; status: string }[] }
interface PrLike { status: string; prUrl: string | null; pr?: { url: string; state: string | null } | null }

export interface RunCounts {
  /** Every active ticket run: work runs, chat replies and Planning runs. */
  runs: number;
  /** The runs that hold one of the board's maxParallel slots. */
  slots: number;
  /** Huddle agents working right now (a ticket's @main is its ticket run, so it isn't counted again). */
  agents: number;
}

export function runCounts(tickets: RunLike[], huddles: HuddleLike[]): RunCounts {
  let agents = 0;
  for (const h of huddles) {
    if (h.status === "live") agents += h.participants.filter((p) => p.kind === "agent" && p.status === "working").length;
  }
  return { runs: tickets.filter((t) => t.running).length, slots: tickets.filter((t) => t.holdsSlot).length, agents };
}

/** The ticket's PR is still open: not Done, and not merged or closed when its status is known. */
export function hasOpenPr(t: PrLike): boolean {
  if (!t.prUrl || t.status === "done") return false;
  const state = t.pr?.url === t.prUrl ? t.pr.state : null;
  return state !== "MERGED" && state !== "CLOSED";
}
