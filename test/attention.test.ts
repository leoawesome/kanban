import { expect, test } from "bun:test";
import { attentionFor, userWaitReason } from "../src/server/attention";
import type { SessionSummary } from "../src/server/session";
import type { Ticket } from "../src/server/types";

const T = (p: Partial<Ticket>): Ticket => ({
  id: "t", title: "T", status: "planning", order: 1, sessionId: "s", worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: "", updatedAt: "", body: "b", ...p,
});
const S = (p: Partial<SessionSummary>): SessionSummary => ({
  title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], ...p,
});

test("running tickets never need the user", () => {
  expect(attentionFor(T({ outcome: "failed" }), S({ openQuestions: 3 }), true)).toBeNull();
});

test("failures and blocks come first", () => {
  expect(attentionFor(T({ outcome: "failed" }), null, false)).toEqual({ kind: "failed", label: "Run failed" });
  expect(attentionFor(T({ outcome: "blocked" }), S({ openQuestions: 2 }), false)!.kind).toBe("blocked");
});

test("open questions", () => {
  expect(attentionFor(T({}), S({ openQuestions: 5 }), false)).toEqual({ kind: "questions", label: "Answer 5 questions" });
  expect(attentionFor(T({}), S({ openQuestions: 1 }), false)!.label).toBe("Answer 1 question");
  expect(attentionFor(T({ outcome: "needs_input" }), null, false)!.kind).toBe("questions");
});

test("unapplied proposal, but not once applied", () => {
  const prop = { title: "New", description: "D" };
  expect(attentionFor(T({}), S({ pendingProposal: prop }), false)).toEqual({ kind: "proposal", label: "Review proposal" });
  expect(attentionFor(T({ title: "New", body: "D" }), S({ pendingProposal: prop }), false)).toBeNull();
});

test("review column and Claude replies in planning", () => {
  expect(attentionFor(T({ status: "review", outcome: "done" }), null, false)).toEqual({ kind: "review", label: "Ready for review" });
  const replied = S({ lastMessage: { role: "assistant", text: "hi", at: "" } });
  expect(attentionFor(T({}), replied, false)).toEqual({ kind: "reply", label: "Claude replied" });
  // Cut off by a restart: not a reply yet.
  expect(attentionFor(T({ interrupted: { at: "", mode: "refine", partial: "Half" } }), replied, false)).toBeNull();
  expect(attentionFor(T({ status: "backlog" }), replied, false)).toBeNull();
  expect(attentionFor(T({ status: "done" }), replied, false)).toBeNull();
  expect(attentionFor(T({}), S({ lastMessage: { role: "user", text: "hi", at: "" } }), false)).toBeNull();
});

test("done and backlog tickets never need the user", () => {
  const prop = { title: "New", description: "D" };
  for (const status of ["done", "backlog"] as const) {
    expect(attentionFor(T({ status }), S({ openQuestions: 2 }), false)).toBeNull();
    expect(attentionFor(T({ status, outcome: "failed" }), null, false)).toBeNull();
    expect(attentionFor(T({ status, outcome: "blocked" }), null, false)).toBeNull();
    expect(attentionFor(T({ status, outcome: "needs_input" }), null, false)).toBeNull();
    expect(attentionFor(T({ status }), S({ pendingProposal: prop }), false)).toBeNull();
  }
  expect(attentionFor(T({ status: "review" }), S({ openQuestions: 2 }), false)!.kind).toBe("questions");
});

test("proposed new tickets need attention until each one exists", () => {
  const s = S({ pendingNewTickets: [{ title: "A", description: "" }, { title: "B", description: "" }] });
  expect(attentionFor(T({}), s, false)).toEqual({ kind: "proposal", label: "Review proposed tickets" });
  expect(attentionFor(T({}), s, false, { createdTitles: new Set(["A"]) })!.kind).toBe("proposal");
  expect(attentionFor(T({}), s, false, { createdTitles: new Set(["A", "B"]) })).toBeNull();
});

test("a stuck plan needs the user, unless the ticket is done or every child is finished", () => {
  const plan = { state: "stuck" as const, maxConcurrent: 2, wakeups: 1, startedAt: "", originalCount: 2, reason: "x" };
  expect(attentionFor(T({ status: "review", plan }), null, false)).toEqual({ kind: "blocked", label: "Plan stuck" });
  expect(attentionFor(T({ status: "done", plan }), null, false)).toBeNull();
  expect(attentionFor(T({ status: "review", outcome: "done", plan }), null, false, { planComplete: true })).toEqual({ kind: "review", label: "Ready for review" });
});

test("userWaitReason: plan children waiting on the user", () => {
  expect(userWaitReason(T({ status: "backlog" }), null)).toBeNull();
  expect(userWaitReason(T({ status: "planning" }), null)).toBe("in Planning");
  expect(userWaitReason(T({ status: "backlog" }), S({ openQuestions: 2 }))).toBe("2 questions for you");
  expect(userWaitReason(T({ status: "review", outcome: "needs_input" }), null)).toBe("has questions for you");
  expect(userWaitReason(T({ status: "backlog" }), S({ pendingProposal: { title: "New", description: "d" } }))).toBe("proposal to apply");
  // Applied already: the ticket matches the proposal.
  expect(userWaitReason(T({ status: "backlog", title: "New", body: "d" }), S({ pendingProposal: { title: "New", description: "d" } }))).toBeNull();
  expect(userWaitReason(T({ status: "done" }), S({ openQuestions: 1 }))).toBeNull();
});
