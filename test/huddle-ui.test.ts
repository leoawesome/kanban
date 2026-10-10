import { expect, test } from "bun:test";
import {
  cardHuddleBadge, draftError, draftSize, guestTickets, handleInitials, mentionCandidates, mentionQuery, mergeMessages, participantActivity, pickHuddle, rosterDraft, rowHandle, shortTicketId, sortHuddles, upsertHuddle,
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

// ---- Board badges and the dock's Huddles list ----

type BP = P & { ticketId?: string | null };
type BH = { id: string; hostTicket: string; hostTitle: string | null; status: string; createdAt: string; updatedAt: string; seq: number; invited: string[]; participants: BP[] };
const bh = (x: Partial<BH> = {}): BH => ({
  id: "h1", hostTicket: "t_20261009_k2pm", hostTitle: "CSV export", status: "live", createdAt: "2026-10-10T01:00:00Z", updatedAt: "2026-10-10T02:00:00Z",
  seq: 12, invited: [],
  participants: [
    p("you", { kind: "human", mode: "monitor" }),
    { ...p("main", { kind: "ticket-main", status: "working" }), ticketId: "t_20261009_k2pm" },
    p("qa-1", { status: "working" }),
    p("dev-1"),
  ],
  ...x,
});

test("cardHuddleBadge: host card of a live huddle counts agents and who is working", () => {
  const b = cardHuddleBadge([bh()], "t_20261009_k2pm");
  expect(b).toMatchObject({ huddleId: "h1", openTicket: "t_20261009_k2pm", state: "live", label: "Huddle · 3 · 2 working" });
  expect(cardHuddleBadge([bh({ status: "stopped" })], "t_20261009_k2pm")?.label).toBe("Huddle · 3 · stopped");
});

test("cardHuddleBadge: an invited ticket points at the host's Huddle tab", () => {
  const h = bh({ invited: ["t_20261008_abcd"], participants: [...bh().participants, { ...p("api", { kind: "ticket-main" }), ticketId: "t_20261008_abcd" }] });
  expect(guestTickets(h)).toEqual(["t_20261008_abcd"]);
  const b = cardHuddleBadge([h], "t_20261008_abcd");
  expect(b).toMatchObject({ state: "guest", openTicket: "t_20261009_k2pm", label: "in huddle of k2pm" });
  // Once the huddle closes, the guest card drops the badge.
  expect(cardHuddleBadge([{ ...h, status: "closed" }], "t_20261008_abcd")).toBeNull();
});

test("cardHuddleBadge: a closed huddle shows its message count; its own open huddle wins over a guest one", () => {
  expect(cardHuddleBadge([bh({ status: "closed", seq: 31 })], "t_20261009_k2pm")?.label).toBe("Huddle · closed · 31 msgs");
  const guestOf = bh({ id: "h2", hostTicket: "t_x_other", invited: ["t_20261009_k2pm"] });
  expect(cardHuddleBadge([guestOf, bh()], "t_20261009_k2pm")?.huddleId).toBe("h1");
  expect(cardHuddleBadge([bh()], "t_nobody")).toBeNull();
  expect(shortTicketId("t_20261009_k2pm")).toBe("k2pm");
});

test("sortHuddles: live, then stopped, then the newest closed ones (capped)", () => {
  const list = [
    bh({ id: "c1", status: "closed", updatedAt: "2026-10-01T00:00:00Z" }),
    bh({ id: "s", status: "stopped" }),
    bh({ id: "c2", status: "closed", updatedAt: "2026-10-05T00:00:00Z" }),
    bh({ id: "l", status: "live", updatedAt: "2026-10-02T00:00:00Z" }),
  ];
  expect(sortHuddles(list).map((h) => h.id)).toEqual(["l", "s", "c2", "c1"]);
  expect(sortHuddles(list, 1).map((h) => h.id)).toEqual(["l", "s", "c2"]);
});

test("upsertHuddle replaces by id or appends", () => {
  const a = bh({ id: "a" }), b = bh({ id: "b" });
  expect(upsertHuddle([a], b).map((h) => h.id)).toEqual(["a", "b"]);
  expect(upsertHuddle([a, b], { ...a, seq: 99 })[0].seq).toBe(99);
});
