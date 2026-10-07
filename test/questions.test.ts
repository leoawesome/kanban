import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { askWaitMs, callTool, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { parseSession } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let board: Board;
let server: ReturnType<typeof createServer>;
let client: BoardClient;
let argsFile: string;

beforeEach(async () => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  client = new BoardClient(server.port);
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  // Fake claude saves its sessions here, so runs can resume them.
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 3, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  store.saveProfile({ ...p, name: "Q", slug: "q", createdAt: new Date(Date.now() + 1).toISOString() });
});

afterEach(async () => {
  await board.shutdown();
  server.stop(true);
  for (const k of ["FAKE_MODE", "FAKE_ARGS_FILE", "FAKE_STEP_MS", "MCP_TOOL_TIMEOUT"]) delete process.env[k];
  delete process.env.CLAUDE_CONFIG_DIR;
}, 15000);

function readArgs(): { args: string[]; prompt: string }[] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const replays = (id: string) =>
  store.readActivity("p", id).map((a: any) => a.event).filter((e: any) => e.type === "user" && e.isReplay)
    .map((e: any) => e.message.content[0].text as string);

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

/** A ticket Claude already worked on (has a session), sitting in Review. */
async function workedTicket(title: string): Promise<Ticket> {
  const t = await board.createTicket("p", { title, body: "", status: "ready" });
  await board.whenIdle();
  return store.getTicket("p", t.id)!;
}

const ctxFor = (asker: string, env: Record<string, string> = {}): ToolContext => ({
  client, cwd: "/", env: { CKANBAN_TICKET: `p/${asker}`, ...env }, sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
});

const text = (r: { content: { text: string }[] }) => r.content[0].text;

test("A asks running B: the question steers B's run as-is and B's reply comes back to A's call", async () => {
  const a = await board.createTicket("p", { title: "Asker", body: "", status: "backlog" });
  process.env.FAKE_STEP_MS = "300";
  const b = await board.createTicket("p", { title: "Builder", body: "", status: "ready" });
  await until(() => board.isRunning("p", b.id) && !!store.getTicket("p", b.id)!.sessionId);

  const asking = callTool("ask_ticket", { id: b.id, question: "Which endpoint did you add?" }, ctxFor(a.id));
  await until(() => replays(b.id).some((m) => m.startsWith("Which endpoint did you add?")));
  const q = store.listQuestions("p")[0];
  const msg = replays(b.id).find((m) => m.startsWith("Which endpoint"))!;
  expect(msg).toContain(`from="${a.id}"`);
  expect(msg).toContain(`question="${q.id}"`);
  expect(msg).toContain("reply_ticket");
  expect(msg).not.toContain("Sent from the kanban board's ticket chat");

  const sent = await callTool("reply_ticket", { questionId: q.id, text: "POST /api/things" }, ctxFor(b.id));
  expect(text(sent)).toContain("got it right away");
  const r = await asking;
  expect(r.isError).toBeUndefined();
  expect(text(r)).toBe(`Reply from ticket ${b.id} "Builder":\n\nPOST /api/things`);
  expect(store.listQuestions("p")[0]).toMatchObject({ delivered: "call", waiting: false, reply: "POST /api/things" });
  await board.whenIdle();
  // Still B's own run: one claude process, ending in Review as usual.
  expect(readArgs().length).toBe(1);
  expect(store.getTicket("p", b.id)!.status).toBe("review");
}, 20000);

test("A asks idle B: a quiet reply run starts on B's session and leaves its card alone", async () => {
  const a = await board.createTicket("p", { title: "Asker", body: "", status: "backlog" });
  const b = await workedTicket("Done work");
  store.updateTicket("p", b.id, { outcome: "blocked" });
  const comments = store.listComments("p", b.id).length;

  const asking = callTool("ask_ticket", { id: b.id, question: "Why did you pick Redis?" }, ctxFor(a.id));
  await until(() => readArgs().length === 2);
  const call = readArgs()[1];
  expect(call.prompt.startsWith("Why did you pick Redis?")).toBe(true);
  expect(call.prompt).toContain(`from="${a.id}"`);
  expect(call.args).toContain("--resume");
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(store.getTicket("p", b.id)!.status).toBe("review");

  const q = store.listQuestions("p")[0];
  await client.replyQuestion("p", q.id, "Already in the stack.", `p/${b.id}`);
  expect(text(await asking)).toContain("Already in the stack.");
  await board.whenIdle();
  const got = store.getTicket("p", b.id)!;
  expect(got).toMatchObject({ status: "review", outcome: "blocked", runCount: 1, runStartedAt: null });
  expect(store.listComments("p", b.id).length).toBe(comments);
}, 20000);

test("asking a Planning ticket replies read-only (plan mode)", async () => {
  const a = await board.createTicket("p", { title: "Asker", body: "", status: "backlog" });
  const b = await workedTicket("Shaping");
  await board.updateTicket("p", b.id, { status: "planning" });
  await board.whenIdle();
  const n = readArgs().length;
  const asking = callTool("ask_ticket", { id: b.id, question: "Scope?" }, ctxFor(a.id));
  await until(() => readArgs().length === n + 1);
  const call = readArgs()[n];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("plan");
  await client.replyQuestion("p", store.listQuestions("p")[0].id, "Small.", `p/${b.id}`);
  expect(text(await asking)).toContain("Small.");
  await board.whenIdle();
  expect(store.getTicket("p", b.id)!.status).toBe("planning");
}, 20000);

test("no reply in time: A's call gives up, a later reply becomes a comment on A", async () => {
  process.env.FAKE_MODE = "ok";
  const a = await board.createTicket("p", { title: "Asker", body: "", status: "backlog" });
  const b = await workedTicket("Slow one");
  const r = await callTool("ask_ticket", { id: b.id, question: "Status?" }, { ...ctxFor(a.id, { MCP_TOOL_TIMEOUT: "16000" }), sleep: Bun.sleep });
  expect(text(r)).toMatch(/^No reply yet from ticket .* \(question q_\w+\); it will arrive later/);
  const q = store.listQuestions("p")[0];
  expect(q.waiting).toBe(false);
  await board.whenIdle();

  const res = await client.replyQuestion("p", q.id, "Halfway there.", `p/${b.id}`);
  expect(res).toEqual({ delivered: "comment", from: a.id });
  const c = store.listComments("p", a.id).at(-1)!;
  expect(c.author).toBe("user");
  expect(c.text).toContain(`Reply from ticket ${b.id} "Slow one"`);
  expect(c.text).toContain("Halfway there.");
  expect(board.isRunning("p", a.id)).toBe(false);
}, 20000);

test("a late reply steers into A's run while A is working", async () => {
  const b = await workedTicket("Answerer");
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "Asker", body: "", status: "ready" });
  await until(() => board.isRunning("p", a.id));
  const r = await callTool("ask_ticket", { id: b.id, question: "Ping?" }, { ...ctxFor(a.id, { MCP_TOOL_TIMEOUT: "16000" }), sleep: Bun.sleep });
  expect(text(r)).toContain("No reply yet");
  const q = store.listQuestions("p")[0];
  const res = await client.replyQuestion("p", q.id, "Pong.", `p/${b.id}`);
  expect(res.delivered).toBe("steer");
  const queued = store.getTicket("p", a.id)!.queued!.at(-1)!;
  expect(queued.peer).toBe(true);
  expect(queued.text.startsWith("Pong.")).toBe(true);
  expect(queued.text).toContain(`from="${b.id}"`);
  expect(store.listQuestions("p")[0].delivered).toBe("steer");
}, 20000);

test("clear errors: outside a run, yourself, no session, other board, unknown or answered question, wrong replier, deadlock", async () => {
  const a = await workedTicket("A");
  const b = await workedTicket("B");
  const fresh = await board.createTicket("p", { title: "Never ran", body: "", status: "backlog" });

  const outside = await callTool("ask_ticket", { profile: "p", id: b.id, question: "x" }, { client, cwd: "/", env: {} });
  expect(outside.isError).toBe(true);
  expect(text(outside)).toContain("only works inside a board run");
  await expect(client.ask("p", a.id, "x", 1000, `p/${a.id}`)).rejects.toThrow(/your own ticket/);
  await expect(client.ask("p", fresh.id, "x", 1000, `p/${a.id}`)).rejects.toThrow(/no Claude session yet.*get_ticket/);
  await expect(client.ask("p", b.id, "x", 1000, `q/${a.id}`)).rejects.toThrow(/own board/);
  await expect(client.ask("p", "t_nope", "x", 1000, `p/${a.id}`)).rejects.toThrow(/not found/);
  await expect(client.replyQuestion("p", "q_nope", "x", `p/${b.id}`)).rejects.toThrow(/unknown question id q_nope/);

  const q = await client.ask("p", b.id, "first?", 60_000, `p/${a.id}`);
  expect(q.toTitle).toBe("B");
  // B is being asked by A, so A can't wait on B's question back until it replies: both would time out.
  await expect(client.ask("p", a.id, "back?", 1000, `p/${b.id}`)).rejects.toThrow(new RegExp(`waiting for your reply to question ${q.id}`));
  await expect(client.replyQuestion("p", q.id, "x", `p/${fresh.id}`)).rejects.toThrow(/was sent to ticket/);
  await expect(client.pollQuestion("p", q.id, false, `p/${b.id}`)).rejects.toThrow(/was asked by ticket/);
  await client.replyQuestion("p", q.id, "yes", `p/${b.id}`);
  await expect(client.replyQuestion("p", q.id, "again", `p/${b.id}`)).rejects.toThrow(/already has a reply/);
  expect(await client.pollQuestion("p", q.id, false, `p/${a.id}`)).toEqual({ reply: "yes" });
}, 20000);

test("askWaitMs: 10 minutes unless MCP_TOOL_TIMEOUT is shorter", () => {
  expect(askWaitMs({})).toBe(600_000);
  expect(askWaitMs({ MCP_TOOL_TIMEOUT: "100000000" })).toBe(600_000);
  expect(askWaitMs({ MCP_TOOL_TIMEOUT: "120000" })).toBe(105_000);
  expect(askWaitMs({ MCP_TOOL_TIMEOUT: "500" })).toBe(600_000);
  expect(askWaitMs({ MCP_TOOL_TIMEOUT: "junk" })).toBe(600_000);
});

test("parseSession shows ticket-to-ticket messages on both sides", () => {
  const line = (o: object) => JSON.stringify({ timestamp: "2026-10-03T10:00:00Z", ...o });
  // Asker's session: the ask_ticket call and the reply it came back with.
  const asker = parseSession([
    line({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__ckanban__ask_ticket", input: { id: "t_b", question: "Which port?" } }] } }),
    line({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: 'Reply from ticket t_b "B":\n\n8080' }] }] } }),
  ].join("\n"));
  expect(asker.entries).toEqual([
    { uuid: "a1", at: "2026-10-03T10:00:00Z", role: "assistant", kind: "text", text: "Which port?", peer: { dir: "out", ticketId: "t_b" } },
    { uuid: "u1", at: "2026-10-03T10:00:00Z", role: "user", kind: "text", text: "8080", peer: { dir: "in", ticketId: "t_b" } },
  ]);
  // Asked session: the question (steered in) and the reply_ticket call; Claude's own questions stay open.
  const asked = parseSession([
    line({ type: "assistant", uuid: "a0", message: { content: [{ type: "text", text: 'Hm.\n<ckanban-questions>[{"question":"Color?","options":[{"label":"Red","recommended":true},{"label":"Blue"}]}]</ckanban-questions>' }] } }),
    line({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", commandMode: "prompt", prompt: 'Which port?\n\n<ckanban-context note="" from="t_a" question="q_1">\n(Question …)\n</ckanban-context>' } }),
    line({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "tu2", name: "mcp__ckanban__reply_ticket", input: { questionId: "q_1", text: "8080" } }] } }),
  ].join("\n"));
  expect(asked.entries.slice(1)).toEqual([
    { uuid: "q1", at: "2026-10-03T10:00:00Z", role: "user", kind: "text", text: "Which port?", peer: { dir: "in", ticketId: "t_a" } },
    { uuid: "a2", at: "2026-10-03T10:00:00Z", role: "assistant", kind: "text", text: "8080", peer: { dir: "out", ticketId: "t_a" } },
  ]);
  expect(asked.openQuestions).toBe(1);
});
