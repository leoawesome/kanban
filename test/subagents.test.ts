import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { createServer } from "../src/server/http";
import { parseSession, pollSessions, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { AGENT_STEP_TAIL, parseAgentTranscript, settleAgent } from "../src/server/subagents";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (content: any, at: string, extra: object = {}) =>
  L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content }, ...extra });
const asst = (content: any[], at: string, extra: object = {}, stop: string | null = null) =>
  L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content, stop_reason: stop }, ...extra });
const agentCall = (id: string, description: string, at: string, input: object = {}) =>
  asst([{ type: "tool_use", id, name: "Agent", input: { description, subagent_type: "Explore", prompt: "Look around", ...input } }], at);

test("parseSession: a sync agent becomes an agent row, done with its report", () => {
  const s = parseSession([
    user("Map the code", "2026-10-07T01:00:00Z"),
    asst([{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo" } }], "2026-10-07T01:00:01Z"),
    agentCall("ag1", "Map audio flow", "2026-10-07T01:00:02Z"),
    user([{ type: "tool_result", tool_use_id: "ag1", content: [{ type: "text", text: "[Subagent hand-back] Notice. The report follows:\n  Found it.\n  \n  - a.ts" }] }],
      "2026-10-07T01:01:32Z", { toolUseResult: { status: "completed", agentType: "Explore", content: [{ type: "text", text: "Found it.\n\n- a.ts" }] } }),
  ].join("\n"));
  expect(s.entries.map((e) => e.kind)).toEqual(["text", "tool", "agent"]);
  const a = s.entries[2].agent!;
  expect(s.entries[2].uuid).toBe("ag1");
  expect(a).toMatchObject({
    toolUseId: "ag1", description: "Map audio flow", type: "Explore", background: false, status: "done",
    startedAt: "2026-10-07T01:00:02Z", endedAt: "2026-10-07T01:01:32Z", result: "Found it.\n\n- a.ts", error: null,
  });
});

test("parseSession: sync report falls back to the hand-back text, unindented", () => {
  const s = parseSession([
    agentCall("ag1", "x", "2026-10-07T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "ag1", content: [{ type: "text", text: "[Subagent hand-back] Notice. The report follows:\n  Found it.\n    nested" }] }], "2026-10-07T01:00:05Z"),
  ].join("\n"));
  expect(s.entries[0].agent!.result).toBe("Found it.\n  nested");
});

test("parseSession: background agents run until their task notification arrives", () => {
  const launch = (id: string, at: string) =>
    user([{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully." }] }], at,
      { toolUseResult: { isAsync: true, status: "async_launched", agentId: `x${id}` } });
  const note = (id: string, status: string, result: string) =>
    `<task-notification>\n<task-id>x${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n<result>${result}</result>\n</task-notification>`;
  const lines = [
    agentCall("b1", "Resolve conflicts", "2026-10-07T01:00:00Z", { run_in_background: true }),
    launch("b1", "2026-10-07T01:00:01Z"),
    agentCall("b2", "Audit events", "2026-10-07T01:00:02Z", { run_in_background: true }),
    launch("b2", "2026-10-07T01:00:03Z"),
    agentCall("b3", "Still going", "2026-10-07T01:00:04Z", { run_in_background: true }),
    launch("b3", "2026-10-07T01:00:05Z"),
  ];
  const running = parseSession(lines.join("\n")).entries.map((e) => e.agent!);
  expect(running.map((a) => [a.status, a.background])).toEqual([["running", true], ["running", true], ["running", true]]);

  lines.push(
    // Queued while Claude was busy (attachment), or delivered as a plain user message.
    L({ type: "attachment", uuid: "n1", timestamp: "2026-10-07T01:05:00Z", attachment: { type: "queued_command", prompt: note("b1", "completed", "All **resolved**."), commandMode: "task-notification" } }),
    user(note("b2", "failed", "Prompt is too long"), "2026-10-07T01:06:00Z"),
  );
  const s = parseSession(lines.join("\n"));
  const [b1, b2, b3] = s.entries.map((e) => e.agent!);
  expect(b1).toMatchObject({ status: "done", result: "All **resolved**.", endedAt: "2026-10-07T01:05:00Z" });
  expect(b2).toMatchObject({ status: "failed", error: "Prompt is too long", endedAt: "2026-10-07T01:06:00Z" });
  expect(b3.status).toBe("running");
  // Notifications aren't chat messages.
  expect(s.entries.every((e) => e.kind === "agent")).toBe(true);
});

test("parseSession: a failed agent call shows the error", () => {
  const s = parseSession([
    agentCall("f1", "Broken", "2026-10-07T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "f1", is_error: true, content: "Agent type 'Nope' not found" }], "2026-10-07T01:00:01Z"),
  ].join("\n"));
  expect(s.entries[0].agent).toMatchObject({ status: "failed", error: "Agent type 'Nope' not found", result: null });
});

test("parseSession: older Task tool calls are agents too", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "t1", name: "Task", input: { description: "Old style", prompt: "p" } }], "2026-10-07T01:00:00Z"));
  expect(s.entries[0]).toMatchObject({ kind: "agent", agent: { description: "Old style", type: null, status: "running" } });
});

const TRANSCRIPT = (done: boolean) => [
  user("Look around", "2026-10-07T01:00:02Z", { isSidechain: true }),
  asst([{ type: "thinking", thinking: "" }], "2026-10-07T01:00:03Z", { isSidechain: true }),
  asst([{ type: "tool_use", id: "s1", name: "Grep", input: { pattern: "level" } }], "2026-10-07T01:00:04Z", { isSidechain: true }),
  user([{ type: "tool_result", tool_use_id: "s1", content: "x" }], "2026-10-07T01:00:05Z", { isSidechain: true }),
  asst([{ type: "text", text: "Share flow is in ShareSheet.tsx." }], "2026-10-07T01:00:06Z", { isSidechain: true }),
  asst([{ type: "tool_use", id: "s2", name: "Read", input: { file_path: "/r/notifications.ts" } }], "2026-10-07T01:00:07Z", { isSidechain: true }),
  ...(done ? [
    user([{ type: "tool_result", tool_use_id: "s2", content: "y" }], "2026-10-07T01:00:08Z", { isSidechain: true }),
    asst([{ type: "text", text: "## Findings\nAll good." }], "2026-10-07T01:00:09Z", { isSidechain: true }, "end_turn"),
  ] : []),
].join("\n") + "\n";

test("parseAgentTranscript: steps, the tool call in flight, and the final report", () => {
  const live = parseAgentTranscript(TRANSCRIPT(false));
  expect(live.steps).toEqual([
    { kind: "tool", text: "Grep: level" },
    { kind: "text", text: "Share flow is in ShareSheet.tsx." },
    { kind: "tool", text: "Read: /r/notifications.ts" },
  ]);
  expect(live.current).toBe("Read: /r/notifications.ts");
  expect(live.final).toBeNull();
  const done = parseAgentTranscript(TRANSCRIPT(true));
  expect(done.steps.length).toBe(3);
  expect(done.current).toBeNull();
  expect(done.final).toBe("## Findings\nAll good.");
  expect(done.lastAt).toBe("2026-10-07T01:00:09Z");
});

function sessionWithAgent() {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, [user("Map the code", "2026-10-07T01:00:00Z"), agentCall("ag1", "Challenges, share", "2026-10-07T01:00:01Z")].join("\n") + "\n");
  const sub = join(dir, sid, "subagents");
  return { configDir, sid, file, sub };
}

test("SessionCache merges subagent transcripts into agent rows and notices their changes", () => {
  const { configDir, sid, file, sub } = sessionWithAgent();
  const cache = new SessionCache({ configDir });
  // No subagents folder yet (or an old session): the row still renders from the parent alone.
  const bare = cache.get(sid)!.entries[1].agent!;
  expect(bare).toMatchObject({ status: "running", stepCount: 0, steps: [], current: null });
  const v0 = cache.version(sid);

  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-abc.meta.json"), L({ agentType: "Explore", description: "Challenges, share", toolUseId: "ag1" }));
  writeFileSync(join(sub, "agent-abc.jsonl"), TRANSCRIPT(false));
  const v1 = cache.version(sid);
  expect(v1).not.toBe(v0);
  const live = cache.get(sid)!.entries[1].agent!;
  expect(live).toMatchObject({ status: "running", stepCount: 3, current: "Read: /r/notifications.ts", updatedAt: "2026-10-07T01:00:07Z" });
  expect(cache.get(sid)).toBe(cache.get(sid));

  // The agent ends its turn: done with its report, even before the parent hears back.
  writeFileSync(join(sub, "agent-abc.jsonl"), TRANSCRIPT(true));
  expect(cache.version(sid)).not.toBe(v1);
  expect(cache.get(sid)!.entries[1].agent).toMatchObject({
    status: "done", current: null, result: "## Findings\nAll good.", endedAt: "2026-10-07T01:00:09Z", stepCount: 3,
  });

  // The parent's result wins for the report and end time.
  appendFileSync(file, user([{ type: "tool_result", tool_use_id: "ag1", content: "Final." }], "2026-10-07T01:00:10Z",
    { toolUseResult: { status: "completed", content: [{ type: "text", text: "Final." }] } }) + "\n");
  expect(cache.get(sid)!.entries[1].agent).toMatchObject({ status: "done", result: "Final.", endedAt: "2026-10-07T01:00:10Z", stepCount: 3 });
});

test("pollSessions emits session.updated when only a subagent transcript changes", () => {
  const { configDir, sid, sub } = sessionWithAgent();
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  store.updateTicket("p", t.id, { sessionId: sid });
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const cache = new SessionCache({ configDir });
  const state = new Map<string, string>();
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(1);
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-abc.meta.json"), L({ toolUseId: "ag1" }));
  writeFileSync(join(sub, "agent-abc.jsonl"), TRANSCRIPT(false));
  pollSessions(store, bus, cache, state);
  expect(seen.length).toBe(2);
});

test("settleAgent: a running agent whose run is gone and went quiet shows as stopped", () => {
  const a = parseSession(agentCall("ag1", "x", "2026-10-07T01:00:00Z")).entries[0].agent!;
  const now = Date.parse("2026-10-07T01:10:00Z");
  expect(settleAgent(a, true, now).status).toBe("running");
  expect(settleAgent(a, false, Date.parse("2026-10-07T01:00:30Z")).status).toBe("running");
  expect(settleAgent(a, false, now).status).toBe("stopped");
  const done = { ...a, status: "done" as const };
  expect(settleAgent(done, false, now)).toBe(done);
});

test("conversation endpoint sends the last steps of each agent; the agent endpoint sends all", async () => {
  const { configDir, sid, sub } = sessionWithAgent();
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-abc.meta.json"), L({ toolUseId: "ag1" }));
  const many = Array.from({ length: 30 }, (_, i) => [
    asst([{ type: "tool_use", id: `s${i}`, name: "Grep", input: { pattern: `p${i}` } }], `2026-10-07T01:01:${String(i).padStart(2, "0")}Z`, { isSidechain: true }),
    user([{ type: "tool_result", tool_use_id: `s${i}`, content: "x" }], `2026-10-07T01:01:${String(i).padStart(2, "0")}Z`, { isSidechain: true }),
  ]).flat();
  writeFileSync(join(sub, "agent-abc.jsonl"), many.join("\n") + "\n");

  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), sessions: new SessionCache({ configDir }) });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
    const t = store.createTicket("p", { title: "x", body: "", status: "review" });
    store.updateTicket("p", t.id, { sessionId: sid });
    const conv = (await (await fetch(`${base}/api/profiles/p/tickets/${t.id}/conversation`)).json()) as any;
    const row = conv.entries.find((e: any) => e.kind === "agent").agent;
    expect(row.stepCount).toBe(30);
    expect(row.steps.length).toBe(AGENT_STEP_TAIL);
    expect(row.steps.at(-1).text).toBe("Grep: p29");
    // Not running and quiet for long: shown as stopped, not spinning forever.
    expect(row.status).toBe("stopped");
    const full = (await (await fetch(`${base}/api/profiles/p/tickets/${t.id}/agent/ag1`)).json()) as any;
    expect(full.steps.length).toBe(30);
    expect((await fetch(`${base}/api/profiles/p/tickets/${t.id}/agent/nope`)).status).toBe(404);
  } finally {
    server.stop(true);
  }
});
