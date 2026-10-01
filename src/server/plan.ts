// Planner orchestration: pure decisions about a plan's children. Board.advancePlans() applies them.
// Ordering is plain code (no tokens); the planner's Claude session is only woken for events below.
import type { Plan, Ticket } from "./types";

export const DEFAULT_MAX_CONCURRENT = 2;
export const MAX_RETRIES = 3;

/** Wake-ups allowed per plan before it counts as stuck: 3 per child, at least 5. */
export function wakeupCap(children: number): number {
  return Math.max(5, children * 3);
}

export function childrenOf(tickets: Ticket[], plannerId: string): Ticket[] {
  return tickets.filter((t) => t.parentId === plannerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.order - b.order);
}

export function planActive(p: Plan | null | undefined): boolean {
  return p?.state === "running" || p?.state === "finishing";
}

/** Done, or finished in Review without a PR to merge (repos that push straight to main). */
export function isComplete(t: Ticket): boolean {
  return t.status === "done" || (t.status === "review" && t.outcome === "done" && !t.prUrl);
}

/** A dependency names a sibling by ticket id or planKey. */
export function resolveDeps(t: Ticket, siblings: Ticket[]): { deps: Ticket[]; missing: string[] } {
  const deps: Ticket[] = [];
  const missing: string[] = [];
  for (const ref of t.dependsOn ?? []) {
    const d = siblings.find((s) => s.id !== t.id && (s.id === ref || (!!s.planKey && s.planKey === ref)));
    if (d) deps.push(d);
    else missing.push(ref);
  }
  return { deps, missing };
}

/** Titles along a dependency cycle among the children, or null. */
export function findCycle(children: Ticket[]): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: Ticket[] = [];
  const visit = (t: Ticket): string[] | null => {
    if (state.get(t.id) === "done") return null;
    if (state.get(t.id) === "visiting") return [...stack.slice(stack.indexOf(t)), t].map((x) => x.title);
    state.set(t.id, "visiting");
    stack.push(t);
    for (const d of resolveDeps(t, children).deps) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(t.id, "done");
    return null;
  };
  for (const t of children) {
    const c = visit(t);
    if (c) return c;
  }
  return null;
}

/** Why a set of children can't be planned, or null when it can. */
export function planProblem(children: Ticket[]): string | null {
  if (!children.length) return "this ticket has no child tickets to run";
  for (const t of children) {
    const { missing } = resolveDeps(t, children);
    if (missing.length) return `"${t.title}" depends on unknown ticket ${missing.map((m) => `"${m}"`).join(", ")}`;
  }
  const cycle = findCycle(children);
  return cycle ? `dependency cycle: ${cycle.join(" → ")}` : null;
}

export interface PlanEvent {
  childId: string;
  /** Child state the event is about; the planner hears about each one once. */
  sig: string;
  line: string;
}

export interface PlanStep {
  /** Children to move to Ready now, in order. */
  start: string[];
  /** New things the planner should decide about. */
  events: PlanEvent[];
  allComplete: boolean;
  /** Children in Ready / In progress (or running a chat). */
  active: number;
  /** Children whose PR the planner was told about and that wait to be merged (the PR poller then marks them done). */
  awaitingMerge: number;
  /** Nothing is running, nothing can start and not everything is done. */
  deadEnd: string | null;
}

function lastError(t: Ticket): string {
  const e = (t.error ?? "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
  return e ? `: ${e}` : "";
}

/** What a running plan should do next, given its children (pure, so it is easy to test). */
export function planStep(plan: Plan, children: Ticket[], running: (id: string) => boolean): PlanStep {
  const seen = plan.seen ?? {};
  const events: PlanEvent[] = [];
  let active = 0;
  let awaitingMerge = 0;
  for (const t of children) {
    const busy = running(t.id) || t.status === "ready" || t.status === "in_progress";
    if (busy) {
      active++;
      continue;
    }
    let ev: PlanEvent | null = null;
    if (t.outcome === "failed" || t.outcome === "blocked" || t.outcome === "needs_input") {
      const what = t.outcome === "needs_input" ? "is asking questions" : t.outcome === "failed" ? "failed" : "is blocked";
      ev = { childId: t.id, sig: `${t.runCount}:${t.outcome}`, line: `${t.id} "${t.title}" ${what} (${t.status})${lastError(t)}` };
    } else if (t.status === "review" && t.outcome === "done" && t.prUrl) {
      ev = { childId: t.id, sig: `${t.runCount}:pr:${t.prUrl}`, line: `${t.id} "${t.title}" finished with an open PR: ${t.prUrl}` };
    }
    if (ev && seen[t.id] !== ev.sig) events.push(ev);
    else if (ev && t.prUrl && t.outcome === "done") awaitingMerge++;
  }
  const allComplete = children.length > 0 && children.every(isComplete);
  const start: string[] = [];
  const room = Math.max(1, plan.maxConcurrent) - active;
  for (const t of children) {
    if (start.length >= room) break;
    if (t.status !== "backlog" || running(t.id)) continue;
    const { deps, missing } = resolveDeps(t, children);
    if (!missing.length && deps.every(isComplete)) start.push(t.id);
  }
  let deadEnd: string | null = null;
  if (!allComplete && !active && !start.length && !events.length && !awaitingMerge) {
    const open = children.filter((t) => !isComplete(t)).map((t) => `"${t.title}" (${t.status}${t.outcome ? `, ${t.outcome}` : ""})`);
    deadEnd = `nothing can run; not done yet: ${open.slice(0, 8).join(", ")}${open.length > 8 ? ` and ${open.length - 8} more` : ""}`;
  }
  return { start, events, allComplete, active, awaitingMerge, deadEnd };
}

/** One line per child for the planner's prompt. */
export function planTable(children: Ticket[]): string {
  return children.map((t) => {
    const deps = resolveDeps(t, children).deps.map((d) => d.id);
    const bits = [t.status, t.outcome, t.prUrl ? `PR ${t.prUrl}` : null, deps.length ? `waits for ${deps.join(", ")}` : null].filter(Boolean);
    return `- ${t.id}${t.planKey ? ` [${t.planKey}]` : ""} "${t.title}": ${bits.join("; ")}`;
  }).join("\n");
}
