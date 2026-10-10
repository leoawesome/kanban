import { expect, test } from "bun:test";
import { Bus, type BusEvent } from "../src/server/events";
import { outputSummary, parseHuddleSession, pollHuddleSessions, STEP_TEXT_MAX } from "../src/server/huddle-session";
import { Store } from "../src/server/store";
import type { Huddle } from "../src/server/types";
import { tempDir } from "./helpers";

const line = (o: unknown) => JSON.stringify(o);
const asst = (...content: unknown[]) => line({ type: "assistant", timestamp: "2026-10-10T10:00:00Z", message: { content } });
const result = (id: string, content: unknown, isError = false) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

test("parseHuddleSession: wakes, reasoning, tool rows with a short output, posts with their number", () => {
  const raw = [
    line({ type: "user", timestamp: "2026-10-10T09:59:00Z", message: { role: "user", content: "You are @qa in a huddle…" } }),
    asst({ type: "thinking", thinking: "Start with the export." }, { type: "text", text: "x".repeat(STEP_TEXT_MAX + 10) }),
    asst({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/src/export.ts" } }),
    result("t1", "a\nb\nc"),
    asst({ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } }),
    result("t2", [{ type: "text", text: "boom: failed\nstack" }], true),
    asst({ type: "tool_use", id: "t3", name: "mcp__ckanban__huddle_post", input: { text: "@main CSV breaks" } }),
    result("t3", "Posted #12 as @qa; woke @main."),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "<huddle digest>" }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "New messages: @qa look again" }] } }),
    asst({ type: "tool_use", id: "t4", name: "Grep", input: { pattern: "join" } }),
    "not json",
  ].join("\n");
  const s = parseHuddleSession(raw);
  expect(s.startedAt).toBe("2026-10-10T09:59:00Z");
  expect(s.steps.map((x) => x.kind)).toEqual(["wake", "text", "text", "tool", "tool", "post", "wake", "tool"]);
  expect(s.steps.map((x) => x.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(s.steps[0].text).toBe("Started on its job");
  expect(s.steps[1].text).toBe("Start with the export.");
  expect(s.steps[2].text.length).toBe(STEP_TEXT_MAX);
  expect(s.steps[3]).toMatchObject({ text: "Read: /r/src/export.ts", out: "3 lines", id: "t1" });
  expect(s.steps[3].pending).toBeUndefined();
  expect(s.steps[4]).toMatchObject({ error: true, out: "boom: failed" });
  expect(s.steps[5]).toMatchObject({ kind: "post", text: "@main CSV breaks", seq: 12 });
  expect(s.steps[6].text).toBe("Woke up with new huddle messages");
  expect(s.steps[7]).toMatchObject({ text: "Grep: join", pending: true });
});

test("outputSummary", () => {
  expect(outputSummary("")).toBe("no output");
  expect(outputSummary("  one line \n\n")).toBe("one line");
  expect(outputSummary("a\nb")).toBe("2 lines");
  expect(outputSummary("first\nsecond", true)).toBe("first");
});

test("pollHuddleSessions: an event per changed agent session, none on the first pass, closed huddles only shortly after", () => {
  const store = new Store(tempDir("ck-home-"));
  store.saveProfile({ name: "P", slug: "p", path: "/x", baseBranch: "main", maxParallel: 1, model: null, createdAt: "" });
  const at = new Date().toISOString();
  const agent = (handle: string, sessionId: string | null) => ({
    handle, role: "QA", preset: null, prompt: "", model: null, mode: "tagged" as const, lead: false, canEdit: false, workspace: "shared" as const,
    sessionId, status: "idle" as const, kind: "agent" as const, cursor: 0, joinedAt: at,
  });
  const h: Huddle = {
    id: "h_1", hostTicket: "t_1", status: "live", maxParticipants: 8, findings: [], invited: [], seq: 0, stopReason: null, createdAt: at, updatedAt: at,
    participants: [agent("qa", "s1"), agent("rev", "s2"), agent("new", null)],
  } as Huddle;
  store.saveHuddle("p", h);
  const bus = new Bus();
  const events: BusEvent[] = [];
  bus.on((e) => events.push(e));
  const versions: Record<string, string> = { s1: "1", s2: "1" };
  const state = new Map<string, string>();
  const poll = (first = false, now?: number) => pollHuddleSessions(store, bus, (id) => versions[id] ?? null, state, first, now);
  poll(true);
  expect(events).toEqual([]);
  versions.s1 = "2";
  poll();
  poll();
  expect(events).toEqual([{ type: "huddle.session", profile: "p", huddleId: "h_1", handle: "qa" }]);
  // A session that shows up later counts as changed.
  store.saveHuddle("p", { ...h, participants: [...h.participants.slice(0, 2), agent("new", "s3")] });
  versions.s3 = "1";
  poll();
  expect(events.at(-1)).toMatchObject({ handle: "new" });
  // Closed: watched for a while, then dropped.
  store.saveHuddle("p", { ...store.getHuddle("p", "h_1")!, status: "closed", closedAt: at });
  versions.s2 = "2";
  poll();
  expect(events.at(-1)).toMatchObject({ handle: "rev" });
  versions.s2 = "3";
  poll(false, Date.now() + 10 * 60_000);
  expect(events.at(-1)).toMatchObject({ handle: "rev" });
  expect(events.length).toBe(3);
  expect(state.size).toBe(0);
});
