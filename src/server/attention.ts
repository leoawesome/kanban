import type { SessionSummary } from "./session";
import type { Ticket } from "./types";

export type AttentionKind = "failed" | "blocked" | "questions" | "proposal" | "review" | "reply";

/** Why a ticket is waiting on the user (shown as a "Your turn" badge), or null if it isn't. */
export interface Attention {
  kind: AttentionKind;
  label: string;
}

/** createdTitles: titles of this ticket's children, to tell which proposed new tickets still wait for a click. */
export function attentionFor(t: Ticket, s: SessionSummary | null, running: boolean, createdTitles?: Set<string>): Attention | null {
  if (running || t.status === "in_progress") return null;
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
  if (s?.pendingNewTickets?.some((n) => !createdTitles?.has(n.title))) return { kind: "proposal", label: "Review proposed tickets" };
  if (t.status === "review") return { kind: "review", label: "Ready for review" };
  if (t.status === "planning" && s?.lastMessage?.role === "assistant") return { kind: "reply", label: "Claude replied" };
  return null;
}
