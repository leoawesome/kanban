import { expect, test } from "bun:test";
import { hasOpenPr, runCounts } from "../web/src/boardStats";

test("runCounts counts every ticket run, the slots apart, and working huddle agents", () => {
  const tickets = [
    { running: true, holdsSlot: true }, // work run
    { running: true, holdsSlot: false }, // Planning chat reply
    { running: true }, // peer reply
    { running: false },
    {},
  ];
  const huddles = [
    { status: "live", participants: [
      { kind: "ticket-main", status: "working" }, { kind: "agent", status: "working" }, { kind: "agent", status: "working" },
      { kind: "agent", status: "idle" }, { kind: "human", status: "idle" },
    ] },
    { status: "closed", participants: [{ kind: "agent", status: "working" }] },
  ];
  expect(runCounts(tickets, huddles)).toEqual({ runs: 3, slots: 1, agents: 2 });
  expect(runCounts([], [])).toEqual({ runs: 0, slots: 0, agents: 0 });
});

test("hasOpenPr leaves out Done tickets and merged or closed PRs", () => {
  const url = "https://github.com/o/r/pull/7";
  const pr = (state: string | null, u = url) => ({ url: u, state });
  expect(hasOpenPr({ status: "review", prUrl: url })).toBe(true);
  expect(hasOpenPr({ status: "review", prUrl: url, pr: pr("OPEN") })).toBe(true);
  expect(hasOpenPr({ status: "review", prUrl: null })).toBe(false);
  expect(hasOpenPr({ status: "done", prUrl: url })).toBe(false);
  expect(hasOpenPr({ status: "review", prUrl: url, pr: pr("MERGED") })).toBe(false);
  expect(hasOpenPr({ status: "in_progress", prUrl: url, pr: pr("CLOSED") })).toBe(false);
  // Status of an older PR doesn't count for the current one.
  expect(hasOpenPr({ status: "review", prUrl: url, pr: pr("MERGED", "https://github.com/o/r/pull/6") })).toBe(true);
});
