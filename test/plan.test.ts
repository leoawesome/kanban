import { expect, test } from "bun:test";
import { findCycle, isComplete, planProblem, planStep, planTable, resolveDeps, wakeupCap } from "../src/server/plan";
import type { Plan, Ticket } from "../src/server/types";

let n = 0;
const T = (p: Partial<Ticket>): Ticket => ({
  id: `t_${++n}`, title: "x", status: "backlog", order: n, sessionId: null, worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`,
  updatedAt: "", body: "", parentId: "t_plan", ...p,
} as Ticket);
const plan = (p: Partial<Plan> = {}): Plan => ({ state: "running", maxConcurrent: 2, wakeups: 0, startedAt: "", originalCount: 5, ...p });
const idle = () => false;

function abcde() {
  const a = T({ title: "A", planKey: "a" });
  const b = T({ title: "B", planKey: "b", dependsOn: ["a"] });
  const c = T({ title: "C", planKey: "c", dependsOn: [a.id] });
  const d = T({ title: "D", planKey: "d", dependsOn: ["b", "c"] });
  const e = T({ title: "E", planKey: "e" });
  return { a, b, c, d, e, all: [a, b, c, d, e] };
}

test("dependencies resolve by key or id; unknown ones are reported", () => {
  const { a, b, c, all } = abcde();
  expect(resolveDeps(b, all).deps).toEqual([a]);
  expect(resolveDeps(c, all).deps).toEqual([a]);
  expect(resolveDeps(T({ dependsOn: ["nope"] }), all).missing).toEqual(["nope"]);
  expect(planProblem(all)).toBeNull();
  expect(planProblem([])).toContain("no child tickets");
  expect(planProblem([...all, T({ title: "Z", dependsOn: ["ghost"] })])).toContain('"Z" depends on unknown ticket "ghost"');
});

test("cycles are found", () => {
  const x = T({ title: "X", planKey: "x", dependsOn: ["y"] });
  const y = T({ title: "Y", planKey: "y", dependsOn: ["x"] });
  expect(findCycle([x, y])).toEqual(["X", "Y", "X"]);
  expect(planProblem([x, y])).toContain("dependency cycle: X → Y → X");
  expect(findCycle(abcde().all)).toBeNull();
});

test("planStep starts eligible children up to the cap, in order", () => {
  const { a, b, c, d, e, all } = abcde();
  expect(planStep(plan(), all, idle).start).toEqual([a.id, e.id]);
  expect(planStep(plan({ maxConcurrent: 1 }), all, idle).start).toEqual([a.id]);
  // A done, E running: one free slot goes to B, then C.
  a.status = "done";
  e.status = "in_progress";
  const s = planStep(plan(), all, idle);
  expect(s.start).toEqual([b.id]);
  expect(s.active).toBe(1);
  b.status = "review";
  b.outcome = "done";
  c.status = "done";
  e.status = "done";
  expect(planStep(plan(), all, idle).start).toEqual([d.id]);
  d.status = "done";
  expect(planStep(plan(), all, idle).allComplete).toBe(true);
});

test("failures, questions and open PRs become events once; dead ends are reported", () => {
  const f = T({ title: "F", status: "review", outcome: "failed", runCount: 1, error: "tests failed" });
  const q = T({ title: "Q", status: "review", outcome: "needs_input", runCount: 1 });
  const p = T({ title: "P", status: "review", outcome: "done", runCount: 1, prUrl: "https://x/pull/1" });
  const s = planStep(plan(), [f, q, p], idle);
  expect(s.events.map((e) => e.line)).toEqual([
    `${f.id} "F" failed (review): tests failed`,
    `${q.id} "Q" is asking questions (review)`,
    `${p.id} "P" finished with an open PR: https://x/pull/1`,
  ]);
  const seen = Object.fromEntries(s.events.map((e) => [e.childId, e.sig]));
  const again = planStep(plan({ seen }), [f, q, p], idle);
  expect(again.events).toEqual([]);
  // The PR waits to be merged, so it's not a dead end yet.
  expect(again.awaitingMerge).toBe(1);
  expect(again.deadEnd).toBeNull();
  expect(planStep(plan({ seen }), [f, q], idle).deadEnd).toContain('"F" (review, failed)');
  // A retry that fails again is a new event.
  expect(planStep(plan({ seen }), [{ ...f, runCount: 2 }], idle).events).toHaveLength(1);
});

test("isComplete, wakeupCap, planTable", () => {
  expect(isComplete(T({ status: "done" }))).toBe(true);
  expect(isComplete(T({ status: "review", outcome: "done" }))).toBe(true);
  expect(isComplete(T({ status: "review", outcome: "done", prUrl: "u" }))).toBe(false);
  expect(isComplete(T({ status: "review", outcome: "failed" }))).toBe(false);
  expect(wakeupCap(1)).toBe(5);
  expect(wakeupCap(30)).toBe(90);
  const { a, b } = abcde();
  expect(planTable([a, b])).toBe(`- ${a.id} [a] "A": backlog\n- ${b.id} [b] "B": backlog; waits for ${a.id}`);
});

test("children that need the same resource start one at a time; others start in parallel", () => {
  const e1 = T({ title: "E1", needs: ["emulator"] });
  const e2 = T({ title: "E2", needs: ["emulator"] });
  const e3 = T({ title: "E3", needs: ["emulator"] });
  const free = T({ title: "Free" });
  const s = planStep(plan({ maxConcurrent: 3 }), [e1, e2, e3, free], idle);
  expect(s.start).toEqual([e1.id, free.id]);
  expect(s.resourceWait).toEqual([{ id: e2.id, resources: ["emulator"] }, { id: e3.id, resources: ["emulator"] }]);
  // Held elsewhere (another ticket, maybe on another board): nothing needing it starts, and that is not a dead end.
  const held = planStep(plan({ maxConcurrent: 3 }), [e2, e3], idle, { held: (t) => (t.needs ?? []).filter((n) => n === "emulator") });
  expect(held.start).toEqual([]);
  expect(held.resourceWait.map((w) => w.id)).toEqual([e2.id, e3.id]);
  expect(held.deadEnd).toBeNull();
});

test("children waiting on the user are never started; alone they end the plan with a reason naming them", () => {
  const asks = T({ title: "Asks" });
  const ok = T({ title: "Ok" });
  const why = (t: Ticket) => (t.id === asks.id ? "2 questions for you" : null);
  const s = planStep(plan(), [asks, ok], idle, { waitingOnUser: why });
  expect(s.start).toEqual([ok.id]);
  expect(s.userWait).toEqual([{ id: asks.id, reason: "2 questions for you" }]);
  expect(s.deadEnd).toBeNull();
  const done = { ...ok, status: "done" as const };
  const end = planStep(plan(), [asks, done], idle, { waitingOnUser: why });
  expect(end.start).toEqual([]);
  expect(end.deadEnd).toBe('waiting for you: "Asks" (2 questions for you)');
  // A child that depends on it is listed too.
  const after = T({ title: "After", dependsOn: [asks.id] });
  expect(planStep(plan(), [asks, done, after], idle, { waitingOnUser: why }).deadEnd)
    .toBe('waiting for you: "Asks" (2 questions for you); also not done: "After" (backlog)');
});

test("planTable lists what a child needs", () => {
  expect(planTable([T({ id: "t_e", title: "E", needs: ["emulator"] })])).toContain("needs emulator");
});
