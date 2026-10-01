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
