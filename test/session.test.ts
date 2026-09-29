import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus, type BusEvent } from "../src/server/events";
import { SessionCache, findSessionFile, parseSession, pollSessions } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (text: any, at: string, extra: object = {}) =>
  L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content: text }, ...extra });
const asst = (content: any[], at: string, extra: object = {}) =>
  L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content }, ...extra });

const RAW = [
  L({ type: "custom-title", customTitle: "flight proposal." }),
  user("<command-name>/clear</command-name>", "2026-09-29T01:00:00Z"),
  user("Draft the flight proposal", "2026-09-29T01:00:01Z"),
  asst([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it." }], "2026-09-29T01:00:02Z"),
  asst([{ type: "tool_use", id: "t1", name: "Artifact", input: { action: "publish", file_path: "/x/flight-autopilot.html" } }], "2026-09-29T01:00:03Z"),
  user([{ type: "tool_result", tool_use_id: "t1", content: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 1)" }], "2026-09-29T01:00:04Z"),
  user([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 2)" }] }], "2026-09-29T01:00:05Z"),
  asst([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "ls -la" } }], "2026-09-29T01:00:06Z"),
  asst([{ type: "text", text: "sidechain noise" }], "2026-09-29T01:00:07Z", { isSidechain: true }),
  user("looks good, ship it", "2026-09-29T01:00:08Z"),
  "garbage line",
].join("\n");

test("parseSession: timeline, artifacts deduped, last message", () => {
  const s = parseSession(RAW);
  expect(s.title).toBe("flight proposal.");
  expect(s.entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "text", "Draft the flight proposal"],
    ["assistant", "text", "On it."],
    ["assistant", "tool", "Artifact: /x/flight-autopilot.html"],
    ["assistant", "tool", "Bash: ls -la"],
    ["user", "text", "looks good, ship it"],
  ]);
  expect(s.artifacts).toEqual([
    { url: "https://claude.ai/artifact/EHESGk3", label: "flight-autopilot", at: "2026-09-29T01:00:05Z" },
  ]);
  expect(s.lastMessage).toEqual({ role: "user", text: "looks good, ship it", at: "2026-09-29T01:00:08Z" });
});

test("parseSession falls back to ai-title and handles empty", () => {
  expect(parseSession(L({ type: "ai-title", aiTitle: "Auto name" })).title).toBe("Auto name");
  const empty = parseSession("");
  expect(empty.entries).toEqual([]);
  expect(empty.lastMessage).toBeNull();
});

test("findSessionFile + cache reparses only on change", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-some-folder");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(file, user("hi", "2026-09-29T01:00:00Z") + "\n");
  expect(findSessionFile("11111111-2222-3333-4444-555555555555", { configDir })).toBe(file);
  expect(findSessionFile("nope", { configDir })).toBeNull();
  const cache = new SessionCache({ configDir });
  const a = cache.get("11111111-2222-3333-4444-555555555555")!;
  expect(cache.get("11111111-2222-3333-4444-555555555555")).toBe(a);
  appendFileSync(file, asst([{ type: "text", text: "hello" }], "2026-09-29T01:00:01Z") + "\n");
  expect(cache.get("11111111-2222-3333-4444-555555555555")!.lastMessage!.text).toBe("hello");
});

test("pollSessions emits session.updated when a linked session file changes", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, user("first", "2026-09-29T01:00:00Z") + "\n");
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid });
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const cache = new SessionCache({ configDir });
  const state = new Map<string, string>();
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(1);
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(1);
  appendFileSync(file, asst([{ type: "text", text: "reply" }], "2026-09-29T01:00:01Z") + "\n");
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(2);
  const e = seen[1] as any;
  expect(e).toMatchObject({ type: "session.updated", profile: "p", id: t.id });
  expect(e.session.lastMessage.text).toBe("reply");
});

test("parseSession hides board instructions and extracts questions + proposals", () => {
  const raw = [
    user('<ckanban-context note="Board started work on the ticket">\nYou are an agent...\n</ckanban-context>', "2026-09-29T02:00:00Z"),
    user('I want to build a habit tracker\n\n<ckanban-context>\nrefine rules\n</ckanban-context>', "2026-09-29T02:00:01Z"),
    asst([{ type: "text", text: 'A few questions:\n<ckanban-questions>\n[{"question":"Who uses it?","options":[{"label":"Just me"},{"label":"Friends","description":"shared","recommended":true}],"multiSelect":false}]\n</ckanban-questions>' }], "2026-09-29T02:00:02Z"),
    user("My answers:\n- Who uses it? → Friends", "2026-09-29T02:00:03Z"),
    asst([{ type: "text", text: 'Here is the ticket:\n<ckanban-ticket>{"title":"Habit tracker MVP","description":"## Goal\\nTrack habits"}</ckanban-ticket>' }], "2026-09-29T02:00:04Z"),
    asst([{ type: "text", text: "<ckanban-questions>not json</ckanban-questions>" }], "2026-09-29T02:00:05Z"),
  ].join("\n");
  const s = parseSession(raw);
  expect(s.entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "board", "Board started work on the ticket"],
    ["user", "text", "I want to build a habit tracker"],
    ["assistant", "text", "A few questions:"],
    ["user", "text", "My answers:\n- Who uses it? → Friends"],
    ["assistant", "text", "Here is the ticket:"],
    ["assistant", "text", "<ckanban-questions>not json</ckanban-questions>"],
  ]);
  expect(s.entries[2].questions).toEqual([
    { question: "Who uses it?", multiSelect: false, options: [
      { label: "Just me", description: undefined, recommended: false },
      { label: "Friends", description: "shared", recommended: true },
    ] },
  ]);
  expect(s.entries[4].proposal).toEqual({ title: "Habit tracker MVP", description: "## Goal\nTrack habits" });
  expect(s.lastMessage!.text).toBe("<ckanban-questions>not json</ckanban-questions>");
});

test("parseSession: open questions and pending proposal reset after the user replies", () => {
  const q = '<ckanban-questions>[{"question":"A?","options":[{"label":"x"}]},{"question":"B?","options":[{"label":"y"}]}]</ckanban-questions>';
  const p = '<ckanban-ticket>{"title":"T2","description":"D2"}</ckanban-ticket>';
  const asked = parseSession([asst([{ type: "text", text: q }], "1")].join("\n"));
  expect(asked.openQuestions).toBe(2);
  const answered = parseSession([asst([{ type: "text", text: q }], "1"), user("answers", "2")].join("\n"));
  expect(answered.openQuestions).toBe(0);
  const proposed = parseSession([user("answers", "2"), asst([{ type: "text", text: p }], "3")].join("\n"));
  expect(proposed.pendingProposal).toEqual({ title: "T2", description: "D2" });
  const after = parseSession([asst([{ type: "text", text: p }], "3"), user("ok", "4")].join("\n"));
  expect(after.pendingProposal).toBeNull();
});
