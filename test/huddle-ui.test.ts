import { expect, test } from "bun:test";
import {
  draftError, draftSize, handleInitials, mentionCandidates, mentionQuery, mergeMessages, participantActivity, pickHuddle, rosterDraft, rowHandle,
} from "../web/src/huddleText";

type P = { handle: string; role: string; kind: string; mode: string; status: string; lastActivity?: string | null; error?: string | null };
type H = { id: string; hostTicket: string; status: string; createdAt: string; participants: P[] };

const p = (handle: string, x: Partial<P> = {}): P => ({ handle, role: handle, mode: "tagged", status: "idle", kind: "agent", ...x });
const huddle = (x: Partial<H> = {}): H => ({
  id: "h1", hostTicket: "t1", status: "live", createdAt: "2026-10-10T01:00:00Z", participants: [p("you", { kind: "human", mode: "monitor" }), p("main", { kind: "ticket-main" }), p("qa-1", { role: "QA", mode: "monitor" })], ...x,
});
const msg = (seq: number) => ({ id: `m${seq}`, seq });

test("pickHuddle: the open one hosted here, else the newest closed one", () => {
  const closedOld = huddle({ id: "a", status: "closed", createdAt: "2026-10-01T00:00:00Z" });
  const closedNew = huddle({ id: "b", status: "closed", createdAt: "2026-10-05T00:00:00Z" });
  const open = huddle({ id: "c", status: "stopped", createdAt: "2026-10-02T00:00:00Z" });
  const elsewhere = huddle({ id: "d", hostTicket: "t2" });
  expect(pickHuddle([closedOld, open, closedNew, elsewhere], "t1")?.id).toBe("c");
  expect(pickHuddle([closedOld, closedNew, elsewhere], "t1")?.id).toBe("b");
  expect(pickHuddle([elsewhere], "t1")).toBeNull();
});

test("mergeMessages: by seq, no duplicates", () => {
  expect(mergeMessages([msg(1), msg(3)], [msg(3), msg(2), msg(4)]).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
});

test("@ autocomplete: the partial before the caret, @main first, never @you", () => {
  expect(mentionQuery("hi @ma", 6)).toEqual({ start: 3, query: "ma" });
  expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionQuery("mail a@b", 8)).toBeNull();
  expect(mentionQuery("@main done", 10)).toBeNull();
  expect(mentionCandidates(huddle()).map((c) => c.handle)).toEqual(["main", "all", "qa-1"]);
});

test("participant activity and initials", () => {
  expect(participantActivity(p("r", { status: "working", lastActivity: "Reading export.ts" }))).toBe("Reading export.ts");
  expect(participantActivity(p("r", { mode: "monitor" }))).toBe("watching");
  expect(participantActivity(p("r"))).toBe("idle");
  expect(participantActivity(p("r", { mode: "monitor" }), true)).toBe("idle");
  expect(participantActivity(p("r", { status: "failed", error: "boom\nmore" }))).toBe("failed: boom");
  expect(handleInitials("qa-2")).toBe("Q2");
  expect(handleInitials("reviewer")).toBe("R");
});

test("roster draft: size counts @main and invites; errors before Start", () => {
  const d = rosterDraft([{ preset: "reviewer" }, { preset: "qa", count: 3 }]);
  expect(draftSize(d)).toBe(5);
  expect(draftError(d)).toBeNull();
  expect(draftSize({ ...d, invites: ["t2"] })).toBe(6);
  expect(draftError({ ...d, rows: [...d.rows, { key: "x", preset: "qa", count: 4 }] })).toContain("over the limit of 8");
  expect(draftError({ ...d, rows: [{ key: "y", role: " " }] })).toBe("Name each custom role.");
  expect(draftError({ ...d, rows: [] })).toBe("Add at least one role.");
  expect(rowHandle({ role: "Accessibility tester" })).toBe("accessibility-tester");
});
