import type { SessionSummary } from "./session";
import type { Ticket } from "./types";

export type AttentionKind = "failed" | "blocked" | "questions" | "proposal" | "review" | "reply";

/** Why a ticket is waiting on the user (shown as a "Your turn" badge), or null if it isn't. */
export interface Attention {
  kind: AttentionKind;
  label: string;
}

/**
 * createdTitles: titles of this ticket's children, to tell which proposed new tickets still wait for a click.
 * managed: the ticket is a child of a running plan, so its planner, not the user, handles it.
 * planComplete: every child of this ticket's plan is finished, so a stuck plan no longer needs the user.
 */
export function attentionFor(
  t: Ticket, s: SessionSummary | null, running: boolean, o: { createdTitles?: Set<string>; managed?: boolean; planComplete?: boolean } = {},
): Attention | null {
  if (t.plan?.state === "stuck" && t.status !== "done" && !o.planComplete) return { kind: "blocked", label: "Plan stuck" };
  if (running || t.status === "in_progress") return null;
  // A running plan's planner and children are handled unattended; the plan pings the user when stuck.
  if (o.managed || t.plan?.state === "running" || t.plan?.state === "finishing" || t.plan?.state === "paused") return null;
  // Done means accepted as-is; Backlog means parked. Neither waits on the user, whatever the session holds.
  if (t.status === "done" || t.status === "backlog") return null;
  if (t.outcome === "failed") return { kind: "failed", label: "Run failed" };
  if (t.outcome === "blocked") return { kind: "blocked", label: "Blocked" };
  const q = s?.openQuestions ?? 0;
  if (q > 0) return { kind: "questions", label: `Answer ${q} question${q === 1 ? "" : "s"}` };
  if (t.outcome === "needs_input") return { kind: "questions", label: "Answer Claude" };
  const p = s?.pendingProposal;
  if (p && !((!p.title || p.title === t.title) && (!p.description || p.description.trim() === t.body.trim()))) {
    return { kind: "proposal", label: "Review proposal" };
  }
  if (s?.pendingNewTickets?.some((n) => !o.createdTitles?.has(n.title))) return { kind: "proposal", label: "Review proposed tickets" };
  if (t.status === "review") return { kind: "review", label: "Ready for review" };
  // A reply cut off by a restart isn't a reply yet: recover() resumes it.
  if (t.status === "planning" && s?.lastMessage?.role === "assistant" && !t.interrupted) return { kind: "reply", label: "Claude replied" };
  return null;
}

/**
 * Why a plan child waits on the user, or null: a plan never starts it, the user has to answer or apply something
 * first (or the planner answers its questions with chat_ticket). Done children never wait.
 */
export function userWaitReason(t: Ticket, s: SessionSummary | null): string | null {
  if (t.status === "done") return null;
  if (t.status === "planning") return "in Planning";
  const q = s?.openQuestions ?? 0;
  if (q > 0) return `${q} question${q === 1 ? "" : "s"} for you`;
  if (t.outcome === "needs_input") return "has questions for you";
  const p = s?.pendingProposal;
  if (p && !((!p.title || p.title === t.title) && (!p.description || p.description.trim() === t.body.trim()))) return "proposal to apply";
  return null;
}
