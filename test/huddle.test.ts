import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Huddles } from "../src/server/huddle";
import { BUILTIN_PRESETS, deletePreset, mergePresets, savePreset } from "../src/server/huddle-presets";
import { parseMentions, rosterError } from "../src/server/huddle-roster";
import { Store } from "../src/server/store";
import type { Huddle, Profile, Ticket } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let huddles: Huddles;
let server: ReturnType<typeof createServer>;
let client: BoardClient;
let heardFile: string;
let argsFile: string;
let events: BusEvent[];

async function setup(idleMs = 300, maxParallel = 3) {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  huddles = new Huddles(store, board, bus, { claudeBin: FAKE, idleMs });
  server = createServer({ store, bus, board, huddles, port: 0, webDir: tempDir("ck-web-") });
  client = new BoardClient(server.port);
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
}

beforeEach(async () => {
  heardFile = join(tempDir("ck-heard-"), "heard.jsonl");
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_HEARD_FILE = heardFile;
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  await setup();
});

afterEach(async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  for (const k of ["FAKE_MODE", "FAKE_ARGS_FILE", "FAKE_HEARD_FILE", "FAKE_STEP_MS", "CLAUDE_CONFIG_DIR"]) delete process.env[k];
}, 15000);

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

const idle = async () => {
  await huddles.whenIdle();
  await board.whenIdle();
};

/** What each session read, by huddle agent handle (or session id for ticket sessions). */
function heard(): { who: string; text: string }[] {
  if (!existsSync(heardFile)) return [];
  return readFileSync(heardFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((x) => ({ who: x.env?.split("/")[1] ?? x.session, text: x.text }));
}
const heardBy = (who: string) => heard().filter((x) => x.who === who).map((x) => x.text);
const processes = () => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

async function host(): Promise<Ticket> {
  return board.createTicket("p", { title: "Login page", body: "Build it", status: "review" });
}

function participant(h: Huddle, handle: string) {
  return store.getHuddle("p", h.id)!.participants.find((p) => p.handle === handle)!;
}

/** MCP context of a huddle agent's run (the env the huddle gave its claude process). */
function agentCtx(h: Huddle, handle: string): ToolContext {
  const p = participant(h, handle);
  return { client, cwd: "/", env: { CKANBAN_TICKET: `p/${h.hostTicket}`, CKANBAN_HUDDLE_AGENT: `${h.id}/${handle}/${p.token}` } };
}
const mainCtx = (h: Huddle): ToolContext => ({ client, cwd: "/", env: { CKANBAN_TICKET: `p/${h.hostTicket}` } });
const text = (r: { content: { text: string }[] }) => r.content[0].text;
const you = (h: Huddle) => store.getHuddle("p", h.id)!.participants.find((p) => p.kind === "human")!;
const messages = (h: Huddle) => store.readHuddleMessages("p", h.id);

test("parseMentions and roster checks", () => {
  expect(parseMentions("@qa-1 and @Reviewer, cc @all. mail a@b.com, path src/@x")).toEqual(["qa-1", "reviewer", "all"]);
  expect(rosterError([{ preset: "qa", count: 3 }, { preset: "reviewer" }])).toBeNull();
  const names = BUILTIN_PRESETS.map((p) => p.name);
  expect(rosterError([{ preset: "nope" }], 8, names)).toContain("unknown preset");
  // Without the board's names only the shape is checked (the daemon checks names).
  expect(rosterError([{ preset: "nope" }])).toBeNull();
  expect(rosterError([{ preset: "main" }], 8, names)).toContain("coordinator");
  expect(rosterError([{ role: "Accessibility tester", prompt: "Check a11y" }], 8, names)).toBeNull();
  expect(rosterError([{ preset: "qa", count: 8 }])).toContain("over the limit of 8");
  expect(rosterError([{ role: "x", handle: "main" }])).toContain("reserved");
});

test("creating a huddle: @you and @main join, agents start on their job with stamped identity and read-only tools", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa", count: 2, focus: "login form" }]);
  expect(h.participants.map((p) => `${p.handle}:${p.kind}:${p.mode}`)).toEqual([
    "you:human:monitor", "main:ticket-main:tagged", "reviewer:agent:tagged", "qa-1:agent:monitor", "qa-2:agent:monitor",
  ]);
  expect(existsSync(store.ticketPath("p", t.id).replace("ticket.md", "")) && store.getHuddle("p", h.id)!.status).toBe("live");
  await idle();
  for (const a of ["reviewer", "qa-1", "qa-2"]) expect(heardBy(a)[0]).toContain(`You just joined the huddle as @${a}`);
  // Agents can't edit tracked files; they get the host's worktree and their own session.
  const runs = processes();
  expect(runs.length).toBe(3);
  for (const r of runs) {
    expect(r.args).toContain("--disallowedTools");
    expect(r.args[r.args.indexOf("--disallowedTools") + 1]).toBe("Edit,Write,NotebookEdit");
    expect(r.args.join(" ")).toContain("You must NOT edit tracked files");
    expect(r.cwd).toBe(store.getTicket("p", t.id)!.worktree);
  }
  expect(new Set(runs.map((r) => r.args[r.args.indexOf("--session-id") + 1])).size).toBe(3);
  // The host's main session was not woken.
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(messages(h)[0]).toMatchObject({ from: "system", kind: "system" });
  expect(events.some((e) => e.type === "huddle.updated")).toBe(true);
  expect(events.some((e) => e.type === "huddle.message")).toBe(true);
  // Tokens never leave the daemon.
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}`);
  expect(JSON.stringify(await res.json())).not.toContain(participant(h, "qa-1").token!);
}, 20000);

test("routing: tagged sleeps, a mention wakes it, monitors get everything, the sender gets nothing, @all wakes everyone", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa", count: 2 }]);
  await idle();
  const before = (who: string) => heardBy(who).length;
  const [r0, q10, q20] = [before("reviewer"), before("qa-1"), before("qa-2")];

  huddles.post("p", h.id, you(h), "hello team");
  await idle();
  expect(heardBy("reviewer").length).toBe(r0);
  expect(heardBy("qa-1").at(-1)).toContain("@you: hello team");
  expect(heardBy("qa-2").at(-1)).toContain("@you: hello team");
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.sessionStarted).toBeFalsy();

  // A mention wakes the tagged reviewer with everything it hasn't read, oldest first.
  huddles.post("p", h.id, you(h), "@reviewer please look at auth.ts");
  await idle();
  const woke = heardBy("reviewer").at(-1)!;
  expect(heardBy("reviewer").length).toBe(r0 + 1);
  expect(woke).toContain("you were tagged");
  expect(woke.indexOf("hello team")).toBeLessThan(woke.indexOf("@reviewer please look"));

  // An agent posts through its MCP tool: it never gets its own message back, the other monitor does.
  const q1 = heardBy("qa-1").length;
  expect(text(await callTool("huddle_post", { text: "found a bug in the form" }, agentCtx(h, "qa-1")))).toContain("as @qa-1");
  await idle();
  expect(heardBy("qa-1").length).toBe(q1);
  expect(heardBy("qa-2").at(-1)).toContain("@qa-1: found a bug in the form");
  expect(heardBy("qa-2").length).toBeGreaterThan(q20);
  expect(heardBy("qa-1").length).toBeGreaterThan(q10);

  // @all wakes the tagged ones too, including @main (the host ticket's own session, as a quiet reply run).
  const r1 = heardBy("reviewer").length;
  huddles.post("p", h.id, you(h), "@all wrap up");
  await until(() => !!store.getTicket("p", t.id)!.sessionStarted);
  await idle();
  expect(heardBy("reviewer").length).toBe(r1 + 1);
  const host1 = store.getTicket("p", t.id)!;
  const mainHeard = heardBy(host1.sessionId!).join("\n");
  expect(mainHeard).toContain("@you: @all wrap up");
  expect(mainHeard).toContain("@qa-1: found a bug in the form");
  // A huddle message leaves the card alone.
  expect(host1.status).toBe("review");
  expect(host1.runCount).toBe(0);
}, 30000);

test("monitor mode: a live session gets messages in its process; mid-turn ones arrive together at the turn boundary", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(5000);
  const t = await host();
  process.env.FAKE_STEP_MS = "250";
  const h = huddles.create("p", t.id, [{ preset: "qa" }]);
  await until(() => heardBy("qa").length === 1);
  // Mid-turn: held back, then handed over as one message.
  huddles.post("p", h.id, you(h), "first note");
  huddles.post("p", h.id, you(h), "second note");
  await Bun.sleep(100);
  expect(heardBy("qa").length).toBe(1);
  await until(() => heardBy("qa").length === 2);
  const batch = heardBy("qa")[1];
  expect(batch).toContain("first note");
  expect(batch).toContain("second note");
  // Idle but still open: the next message goes into the same process.
  await until(() => participant(h, "qa").status === "idle");
  huddles.post("p", h.id, you(h), "third note");
  await until(() => heardBy("qa").length === 3);
  expect(processes().length).toBe(1);
  // Switching to tagged lets the idle session end.
  huddles.setMode("p", h.id, you(h), "qa", "tagged");
  await until(() => participant(h, "qa").status === "idle" && !huddles.isRunning("p", store.getHuddle("p", h.id)!, participant(h, "qa")));
  huddles.post("p", h.id, you(h), "nobody tagged");
  await idle();
  expect(heardBy("qa").length).toBe(3);
}, 30000);

test("sender identity comes from the run, never from tool input", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  await callTool("huddle_post", { text: "I am main", from: "main", sender: "main", handle: "main" }, agentCtx(h, "reviewer"));
  expect(messages(h).at(-1)).toMatchObject({ from: "reviewer", text: "I am main" });
  // A forged token is refused; so is another huddle's agent.
  const forged = agentCtx(h, "reviewer");
  forged.env.CKANBAN_HUDDLE_AGENT = `${h.id}/reviewer/forged`;
  const r = await callTool("huddle_post", { text: "x" }, forged);
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("unknown huddle agent");
  // The host ticket's own run is @main.
  await callTool("huddle_post", { text: "coordinating" }, mainCtx(h));
  expect(messages(h).at(-1)).toMatchObject({ from: "main" });
  // A ticket that isn't in the huddle can't post.
  const other = await board.createTicket("p", { title: "Other", body: "", status: "backlog" });
  const r2 = await callTool("huddle_post", { text: "hi", huddle: h.id }, { client, cwd: "/", env: { CKANBAN_TICKET: `p/${other.id}` } });
  expect(text(r2)).toContain("not in huddle");
  // HTTP without a run header is the user; the body can't pick a sender.
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "from the board", from: "main" }),
  });
  expect(((await res.json()) as any).from).toBe("you");
}, 20000);

test("only leads and the coordinator add participants, and the cap is enforced", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }, { preset: "qa-lead" }], { maxParticipants: 4 });
  await idle();
  const denied = await callTool("huddle_add_participant", { preset: "qa", focus: "forms" }, agentCtx(h, "reviewer"));
  expect(denied.isError).toBe(true);
  expect(text(denied)).toContain("only a lead or @main");
  const ok = await callTool("huddle_add_participant", { preset: "qa", focus: "forms" }, agentCtx(h, "qa-lead"));
  expect(text(ok)).toContain("Added @qa");
  expect(text(ok)).toContain("4/4 participants");
  // Full: the coordinator is refused too, and told to ask the user.
  const full = await callTool("huddle_add_participant", { preset: "qa", focus: "more" }, mainCtx(h));
  expect(full.isError).toBe(true);
  expect(text(full)).toContain("the huddle is full: 4 of 4");
  expect(text(full)).toContain("ask the user");
  expect(() => huddles.invite("p", h.id, you(h), t.id)).toThrow();
  await idle();
  // The new agent started on its job.
  expect(heardBy("qa")[0]).toContain("You just joined the huddle as @qa");
  expect(participant(h, "qa").focus).toBe("forms");
  // A roster over the cap can't start.
  const t2 = await board.createTicket("p", { title: "Second", body: "", status: "review" });
  expect(() => huddles.create("p", t2.id, [{ preset: "qa", count: 4 }], { maxParticipants: 4 })).toThrow("over the limit of 4");
}, 20000);

test("findings: leads and @main manage the pinned list, others can only read it", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa" }, { preset: "qa-lead" }]);
  await idle();
  expect((await callTool("huddle_findings", { action: "add", text: "nope" }, agentCtx(h, "qa"))).isError).toBe(true);
  expect(text(await callTool("huddle_findings", { action: "add", text: "Submit button double-posts" }, agentCtx(h, "qa-lead")))).toContain("f1 [open]");
  expect(text(await callTool("huddle_findings", { action: "resolve", id: "f1" }, mainCtx(h)))).toContain("f1 [resolved by @main]");
  expect(text(await callTool("huddle_findings", { action: "list" }, agentCtx(h, "qa")))).toContain("Submit button double-posts");
  const read = text(await callTool("huddle_read", {}, agentCtx(h, "qa")));
  expect(read).toContain("You are @qa.");
  expect(read).toContain("@qa-lead: QA lead, lead, monitor");
  expect(read).toContain("pinned finding f1");
}, 20000);

test("huddle_mode switches your own mode only", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  expect(text(await callTool("huddle_mode", { mode: "monitor" }, agentCtx(h, "reviewer")))).toContain("@reviewer is now in monitor mode");
  expect(participant(h, "reviewer").mode).toBe("monitor");
  expect(() => huddles.setMode("p", h.id, participant(h, "reviewer"), "main", "monitor")).toThrow("your own mode");
  expect(messages(h).at(-1)!.text).toContain("@reviewer switched to monitor mode");
}, 20000);

test("stop all stops every run and routing until resumed; close keeps the history read-only", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(60_000);
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa", count: 2 }, { preset: "reviewer" }]);
  await until(() => heardBy("qa-1").length === 1 && heardBy("qa-2").length === 1 && heardBy("reviewer").length === 1);
  expect(huddles.isRunning("p", store.getHuddle("p", h.id)!, participant(h, "qa-1"))).toBe(true);
  // Only the user can stop.
  const r = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/stop`, {
    method: "POST", headers: { "content-type": "application/json", "x-ckanban-run": `p/${t.id}` }, body: "{}",
  });
  expect(r.status).toBe(403);
  const res = await fetch(`${client.url}/api/profiles/p/huddles/${h.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(((await res.json()) as any).status).toBe("stopped");
  await idle();
  const stopped = store.getHuddle("p", h.id)!;
  expect(stopped.participants.filter((p) => p.kind !== "human").every((p) => p.status === "stopped")).toBe(true);
  for (const p of stopped.participants) expect(huddles.isRunning("p", stopped, p)).toBe(false);
  // Stopped: messages are kept, nobody wakes; stopped agents can't post.
  const n = heard().length;
  huddles.post("p", h.id, you(h), "@all still there?");
  await idle();
  expect(heard().length).toBe(n);
  expect((await callTool("huddle_post", { text: "x" }, agentCtx(h, "qa-1"))).isError).toBe(true);
  // Resume: routing again.
  huddles.resume("p", h.id);
  huddles.post("p", h.id, you(h), "@reviewer go");
  await until(() => heardBy("reviewer").length === 2);
  // Close: every run stops, history stays and is read-only.
  huddles.close("p", h.id);
  await idle();
  const closed = store.getHuddle("p", h.id)!;
  expect(closed.status).toBe("closed");
  expect(closed.closedAt).toBeTruthy();
  for (const p of closed.participants) expect(huddles.isRunning("p", closed, p)).toBe(false);
  expect(() => huddles.post("p", h.id, you(h), "hello?")).toThrow("closed (read-only)");
  expect(() => huddles.resume("p", h.id)).toThrow("closed");
  expect(messages(h).at(-1)!.text).toContain("Huddle closed by @you");
  const page = await client.huddleRead("p", h.id, {}, {});
  expect(page.messages.length).toBe(messages(h).length);
  // A new huddle can start on the ticket once the old one is closed.
  expect(huddles.create("p", t.id, [{ preset: "reviewer" }]).status).toBe("live");
}, 30000);

test("huddle runs don't take board slots", async () => {
  await Promise.all([board.shutdown(), huddles.shutdown()]);
  server.stop(true);
  await setup(60_000, 1);
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "qa", count: 2 }]);
  await until(() => heardBy("qa-1").length === 1 && heardBy("qa-2").length === 1);
  expect(huddles.isRunning("p", store.getHuddle("p", h.id)!, participant(h, "qa-1"))).toBe(true);
  expect(board.running("p")).toBe(0);
  // maxParallel is 1 and two huddle agents are live: a Ready ticket still starts.
  const work = await board.createTicket("p", { title: "Work", body: "", status: "ready" });
  expect(board.isRunning("p", work.id)).toBe(true);
  expect(board.running("p")).toBe(1);
  huddles.stopAll("p", h.id);
}, 30000);

test("own workspace: the agent gets a worktree off the host's branch and may edit there", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "engineer", focus: "API" }]);
  await idle();
  const p = participant(h, "engineer");
  expect(p.canEdit).toBe(true);
  expect(p.branch).toBe(`ck/${t.id}-engineer`);
  expect(p.worktree && existsSync(p.worktree)).toBe(true);
  const run = processes()[0];
  expect(run.cwd).toBe(p.worktree);
  expect(run.args).not.toContain("--disallowedTools");
}, 20000);

test("a daemon restart resumes agents cut off mid-turn", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "2000";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await until(() => heardBy("reviewer").length === 1);
  await huddles.shutdown();
  expect(participant(h, "reviewer").interrupted).toBe(true);
  delete process.env.FAKE_STEP_MS;
  const again = new Huddles(store, board, bus, { claudeBin: FAKE, idleMs: 300 });
  again.recover();
  await again.whenIdle();
  expect(heardBy("reviewer").at(-1)).toContain("The board restarted while you were working");
  expect(processes().at(-1)!.args).toContain("--resume");
  expect(participant(h, "reviewer")).toMatchObject({ status: "idle", interrupted: false });
}, 20000);

test("propose_huddle validates the roster and starts nothing", async () => {
  const r = await callTool("propose_huddle", { roster: [{ preset: "reviewer" }, { preset: "qa", count: 3, workspace: "shared" }, { preset: "qa-lead" }] }, mainCtx({ hostTicket: "x" } as Huddle));
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("Shown to the user as a card");
  const bad = await callTool("propose_huddle", { roster: [{ preset: "qa", count: 9 }] }, mainCtx({ hostTicket: "x" } as Huddle));
  expect(bad.isError).toBe(true);
  expect(store.listHuddles("p")).toEqual([]);
});

test("presets: board presets merge with built-ins; overriding and resetting a built-in", () => {
  const added = savePreset([], { name: "A11y Tester", prompt: "Check accessibility.", mode: "monitor" });
  expect(added.preset).toMatchObject({ name: "a11y-tester", role: "A11y tester", mode: "monitor", workspace: "shared", canEdit: false, lead: false, model: null });
  // Overriding keeps the built-in's other fields.
  const over = savePreset(added.board, { name: "qa", prompt: "Only test the API.", model: "sonnet" });
  expect(over.preset).toMatchObject({ name: "qa", role: "QA tester", mode: "monitor", model: "sonnet", prompt: "Only test the API." });
  const merged = mergePresets(over.board);
  expect(merged.map((p) => p.name)).toEqual([...BUILTIN_PRESETS.map((p) => p.name), "a11y-tester"]);
  expect(merged.find((p) => p.name === "qa")!.source).toBe("override");
  expect(merged.find((p) => p.name === "reviewer")!.source).toBe("builtin");
  expect(merged.find((p) => p.name === "a11y-tester")!.source).toBe("board");
  // Deleting an override resets the built-in; a built-in itself can't be deleted.
  const reset = deletePreset(over.board, "qa");
  expect(reset.reset).toBe(true);
  expect(mergePresets(reset.board).find((p) => p.name === "qa")).toMatchObject({ source: "builtin", model: null });
  expect(() => deletePreset(reset.board, "qa")).toThrow("built-in");
  expect(deletePreset(reset.board, "a11y-tester")).toEqual({ board: [], reset: false });
  expect(() => savePreset([], { name: "you", prompt: "x" })).toThrow("reserved");
  expect(() => savePreset([], { name: "x" })).toThrow("prompt is required");
  expect(() => savePreset([], { name: "x", prompt: "p", mode: "loud" })).toThrow("mode");
});

test("presets: saved through the MCP tool from a run, used by rosters, deleted over HTTP", async () => {
  const t = await host();
  const ctx: ToolContext = { client, cwd: "/", env: { CKANBAN_TICKET: `p/${t.id}` } };
  const saved = await callTool("save_huddle_preset", { name: "a11y", role: "Accessibility tester", prompt: "Check keyboard and screen reader use.", model: "haiku", workspace: "own", canEdit: false }, ctx);
  expect(saved.isError).toBeUndefined();
  expect(text(saved)).toContain('Saved preset "a11y"');
  expect(store.listHuddlePresets("p")).toEqual([
    { name: "a11y", role: "Accessibility tester", prompt: "Check keyboard and screen reader use.", model: "haiku", mode: "tagged", lead: false, canEdit: false, workspace: "own" },
  ]);
  await callTool("save_huddle_preset", { name: "main", prompt: "Coordinate tersely." }, ctx);
  const list = text(await callTool("list_huddle_presets", {}, ctx));
  expect(list).toContain("- a11y: Accessibility tester (tagged, own worktree, model haiku; board)");
  expect(list).toContain("- main: Coordinator (tagged, shared worktree, lead; built-in, changed on this board)");

  // propose_huddle knows the board's presets.
  expect((await callTool("propose_huddle", { roster: [{ preset: "a11y" }] }, ctx)).isError).toBeUndefined();
  const bad = await callTool("propose_huddle", { roster: [{ preset: "nope" }] }, ctx);
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("a11y");

  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [{ preset: "a11y" }, { role: "Copy editor", prompt: "Fix the wording." }]);
  expect(participant(h, "a11y")).toMatchObject({ role: "Accessibility tester", preset: "a11y", model: "haiku", workspace: "own", canEdit: false });
  expect(participant(h, "copy-editor")).toMatchObject({ role: "Copy editor", preset: null, prompt: "Fix the wording." });
  expect(participant(h, "main")).toMatchObject({ role: "Coordinator", preset: "main", prompt: "Coordinate tersely." });
  await huddles.stopAll("p", h.id);

  const del = await callTool("delete_huddle_preset", { name: "main" }, ctx);
  expect(text(del)).toContain("Reset");
  const r = await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/huddle-presets/a11y`, { method: "DELETE" });
  expect(r.status).toBe(200);
  const builtin = await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/huddle-presets/reviewer`, { method: "DELETE" });
  expect(builtin.status).toBe(409);
  expect(store.listHuddlePresets("p")).toEqual([]);
}, 20000);

test("an agent's cost adds up from its session's running totals", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  expect(participant(h, "reviewer").costUsd).toBeCloseTo(0.01);
  // A resumed session reports the same running total: nothing new was spent.
  huddles.post("p", h.id, you(h), "@reviewer again");
  await idle();
  expect(participant(h, "reviewer").costUsd).toBeCloseTo(0.01);
});
