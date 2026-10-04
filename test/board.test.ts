import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { run } from "../src/server/git";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let argsFile: string;
let liveSessions: Set<string>;

async function setup(opts: { git?: boolean; maxParallel?: number } = {}): Promise<Profile> {
  const path = opts.git === false ? tempDir("ck-plain-") : await makeRepo();
  const p: Profile = {
    name: "P", slug: "p", path, baseBranch: "main", maxParallel: opts.maxParallel ?? 1,
    model: null, createdAt: new Date().toISOString(),
  };
  store.saveProfile(p);
  return p;
}

function readArgs(): { args: string[]; cwd: string; prompt: string }[] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  liveSessions = new Set();
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async (id) => liveSessions.has(id) });
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_PR = "https://github.com/x/y/pull/7";
});

afterEach(async () => {
  // shutdown(), not stopAll(): stopping frees a slot and would start the next queued (slow) ticket.
  await board.shutdown();
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_PR;
  delete process.env.FAKE_ARGS_FILE;
}, 10000);

test("ready ticket runs to review with PR and AI comment", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Add thing", body: "desc", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("done");
  expect(got.prUrl).toBe("https://github.com/x/y/pull/7");
  expect(got.runCount).toBe(1);
  expect(got.worktree).not.toBeNull();
  expect(existsSync(got.worktree!)).toBe(true);
  expect(got.branch).toStartWith(`ck/${t.id}-add-thing`);
  expect(got.lastActivity).toBe("Finished");
  const comments = store.listComments("p", t.id);
  expect(comments.at(-1)).toMatchObject({ author: "ai", text: "fake done" });
  const call = readArgs()[0];
  expect(call.args).toContain("--session-id");
  expect(call.args).toContain(got.sessionId!);
  expect(call.cwd).toBe(got.worktree!);
  expect(store.readActivity("p", t.id).length).toBe(5);
});

test("maxParallel limits concurrent runs", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  await board.createTicket("p", { title: "a", body: "", status: "ready" });
  const b = await board.createTicket("p", { title: "b", body: "", status: "ready" });
  await Bun.sleep(500);
  expect(board.running("p")).toBe(1);
  expect(store.getTicket("p", b.id)!.status).toBe("ready");
}, 15000);

test("failed run marks outcome failed with stderr", async () => {
  await setup();
  process.env.FAKE_MODE = "fail";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("failed");
  expect(got.error).toContain("boom");
});

test("blocked result marks outcome blocked", async () => {
  await setup();
  process.env.FAKE_MODE = "blocked";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("blocked");
});

test("no result line still done with final text comment", async () => {
  await setup();
  process.env.FAKE_MODE = "noresult";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.outcome).toBe("done");
  expect(store.listComments("p", t.id).at(-1)!.text).toBe("All done, no result line.");
});

test("rework resumes session with new user comments", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await Bun.sleep(5);
  board.addComment("p", t.id, "please use blue");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--resume");
  const prompt = calls[1].prompt;
  expect(prompt).toContain("please use blue");
  expect(calls[1].cwd).toBe(calls[0].cwd);
  expect(store.getTicket("p", t.id)!.runCount).toBe(2);
});

test("moving running ticket out of in_progress stops the run", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  expect(board.running("p")).toBe(1);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.whenIdle();
  expect(board.running("p")).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("backlog");
  expect(got.outcome).toBe("stopped");
}, 15000);

test("stop moves to review with stopped outcome", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  board.stop("p", t.id);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
}, 15000);

test("stop during worktree setup shows Stopping… and never spawns claude", async () => {
  await setup();
  const seen: (string | null)[] = [];
  bus.on((e) => { if (e.type === "ticket.updated") seen.push(e.ticket.lastActivity); });
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  expect(board.stop("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.lastActivity).toBe("Stopping…");
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  expect(seen).toContain("Stopping…");
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
  expect(got.lastActivity).toBeNull();
});

test("stop keeps Stopping… on the card while the process shuts down", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  board.stop("p", t.id);
  expect(store.getTicket("p", t.id)!.lastActivity).toBe("Stopping…");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.lastActivity).toBeNull();
}, 15000);

test("stop on an in_progress ticket with no live run clears it", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  expect(board.stop("p", t.id)).toBe(true);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("stopped");
  expect(store.listComments("p", t.id).some((c) => c.text === "Run stopped by user.")).toBe(true);
});

test("stop with nothing running is a no-op", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "backlog" });
  expect(board.stop("p", t.id)).toBe(false);
  expect(store.getTicket("p", t.id)!.status).toBe("backlog");
});

test("recover moves in_progress back to ready and runs", async () => {
  await setup();
  const t = store.createTicket("p", { title: "x", body: "", status: "in_progress" });
  board.recover();
  await Bun.sleep(50);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(store.listComments("p", t.id)[0].text).toContain("Interrupted by daemon restart");
});

test("non-git profile runs in profile path without worktree", async () => {
  const p = await setup({ git: false });
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(readArgs()[0].cwd).toBe(p.path);
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain("NOT a git repository");
});

test("repo with no commits runs in the folder with a notice, then worktrees once it has a commit", async () => {
  const p = await setup({ git: false });
  await run(["git", "init", "-q", "-b", "main"], p.path);
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.worktree).toBeNull();
  expect(got.notice).toContain("no commits yet");
  expect(readArgs()[0].cwd).toBe(p.path);

  // A follow-up run stays in the folder: its Claude session lives there.
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs()[1].cwd).toBe(p.path);

  writeFileSync(join(p.path, "a.txt"), "a\n");
  await run(["git", "add", "."], p.path);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], p.path);
  const t2 = await board.createTicket("p", { title: "y", body: "", status: "ready" });
  await board.whenIdle();
  const got2 = store.getTicket("p", t2.id)!;
  expect(got2.worktree).toBeTruthy();
  expect(readArgs()[2].cwd).toBe(got2.worktree!);
  expect(got2.notice ?? null).toBeNull();
});

test("wrong saved base branch is corrected from the repo", async () => {
  const p = await setup();
  await run(["git", "branch", "-m", "main", "master"], p.path);
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("done");
  expect(got.worktree).toBeTruthy();
  expect(store.getProfile("p")!.baseBranch).toBe("master");
  expect(got.notice).toContain('"master"');
  await board.updateTicket("p", t.id, { notice: null });
  expect(store.getTicket("p", t.id)!.notice).toBeNull();
});

test("refine that cannot start can be retried by moving into Planning again", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  // Make worktree creation fail: a branch nested under the ticket's branch name blocks creating it.
  const blocker = `ck/${t.id}-x/blocker`;
  await run(["git", "branch", blocker], p.path);
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  let got = store.getTicket("p", t.id)!;
  expect(got.outcome).toBe("failed");
  expect(got.refineStarted).toBe(false);
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("Could not start");
  await run(["git", "branch", "-D", blocker], p.path);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeTruthy();
  expect(got.refineStarted).toBe(true);
});

test("moving to done removes clean worktree", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const wt = store.getTicket("p", t.id)!.worktree!;
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(wt)).toBe(false);
  expect(store.getTicket("p", t.id)!.worktree).toBeNull();
});

test("planningCommand creates session + worktree", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Plan me", body: "", status: "planning" });
  const cmd = await board.planningCommand("p", t.id);
  const got = store.getTicket("p", t.id)!;
  expect(got.sessionId).not.toBeNull();
  expect(existsSync(got.worktree!)).toBe(true);
  expect(cmd).toContain(`--session-id ${got.sessionId}`);
  expect(cmd).toContain(store.ticketPath("p", t.id));
});

test("emits ticket.updated events", async () => {
  await setup();
  const seen: string[] = [];
  bus.on((e) => { if (e.type === "ticket.updated") seen.push(e.ticket.status); });
  await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  expect(seen).toContain("in_progress");
  expect(seen.at(-1)).toBe("review");
});

test("shutdown leaves running ticket in_progress for recovery", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  await board.shutdown();
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
}, 15000);

test("moving a running ticket to ready restarts it and keeps in_progress", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(500);
  await board.updateTicket("p", t.id, { status: "ready" });
  await Bun.sleep(200);
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
}, 15000);

test("shutdown during worktree setup never spawns claude", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.shutdown();
  await Bun.sleep(300);
  expect(readArgs().length).toBe(0);
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
});

test("body update with stale expectedBody is rejected", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "old", status: "planning" });
  store.updateTicket("p", t.id, { body: "plan from claude" });
  await expect(board.updateTicket("p", t.id, { body: "mine", expectedBody: "old" })).rejects.toThrow(/changed/);
  expect(store.getTicket("p", t.id)!.body).toBe("plan from claude");
  await board.updateTicket("p", t.id, { body: "mine", expectedBody: "plan from claude" });
  expect(store.getTicket("p", t.id)!.body).toBe("mine");
});

test("linked session runs in profile folder with --resume and no worktree", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "OS status", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  const linked = store.getTicket("p", t.id)!;
  expect(linked.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(linked.workdir).toBe(p.path);
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.cwd).toBe(p.path);
  expect(call.args).toContain("--resume");
  expect(call.args).toContain("11111111-2222-3333-4444-555555555555");
  const got = store.getTicket("p", t.id)!;
  expect(got.worktree).toBeNull();
  expect(got.status).toBe("review");
});

test("run refuses when the linked session is still open in a terminal", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  liveSessions.add("11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("blocked");
  expect(store.listComments("p", t.id).at(-1)!.text).toContain("still open in a terminal");
});

test("done on linked ticket never removes the profile folder", async () => {
  const p = await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "done" });
  expect(existsSync(p.path)).toBe(true);
});

test("cannot link while running", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(300);
  await expect(board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555")).rejects.toThrow(/running/);
}, 15000);

test("interview ticket asking questions lands in review as needs_input", async () => {
  await setup();
  process.env.FAKE_MODE = "questions";
  const t = await board.createTicket("p", { title: "explore", body: "", status: "ready", mode: "interview" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.mode).toBe("interview");
  expect(got.status).toBe("review");
  expect(got.outcome).toBe("needs_input");
  expect(got.interviewed).toBe(true);
  expect(readArgs()[0].prompt).toContain("interview first");
  const c = store.listComments("p", t.id).at(-1)!;
  expect(c.text).toContain("Work complete.");
  expect(c.text).not.toContain("CKANBAN_RESULT");
});

test("runs get an outputs folder and deliverables are listed", async () => {
  await setup();
  process.env.FAKE_OUTPUT = "# Report\nTL;DR";
  try {
    const t = await board.createTicket("p", { title: "research", body: "", status: "ready" });
    await board.whenIdle();
    const outs = store.listOutputs("p", t.id);
    expect(outs.map((o) => o.name)).toEqual(["report.md"]);
    expect(store.outputPath("p", t.id, "report.md")).not.toBeNull();
    expect(store.outputPath("p", t.id, "../ticket.md")).toBeNull();
  } finally {
    delete process.env.FAKE_OUTPUT;
  }
});

test("chat in Planning refines read-only and keeps the card in place", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "App idea", body: "habit tracker", status: "backlog" });
  await board.chat("p", t.id, "Help me shape this idea");
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(board.running("p")).toBe(0);
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("backlog");
  expect(got.runCount).toBe(0);
  expect(got.sessionStarted).toBe(true);
  const call = readArgs()[0];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("plan");
  // The planning tools come from the board's own MCP server, whatever the user registered.
  expect(JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1]).mcpServers.ckanban.args.at(-1)).toBe("mcp");
  const prompt = call.prompt;
  expect(prompt.startsWith("Help me shape this idea")).toBe(true);
  expect(prompt).toContain("<ckanban-context");
  expect(prompt).toContain("propose_ticket");
  expect(prompt).toContain("<ckanban-ticket>");
  // second message resumes the same session
  await board.chat("p", t.id, "Just for me");
  await board.whenIdle();
  expect(readArgs()[1].args).toContain("--resume");
});

test("planning replies save their mockup blocks to outputs/mockups; work runs don't", async () => {
  await setup();
  process.env.FAKE_EXTRA = '\n<ckanban-mockup name="a-compact.html"><!doctype html><p>A</p></ckanban-mockup>';
  try {
    const t = await board.createTicket("p", { title: "New sidebar", body: "d", status: "backlog" });
    await board.chat("p", t.id, "Show me options");
    await board.whenIdle();
    const file = join(store.outputsDir("p", t.id), "mockups", "a-compact.html");
    expect(readFileSync(file, "utf8")).toBe("<!doctype html><p>A</p>\n");
    const w = await board.createTicket("p", { title: "Work", body: "d", status: "review" });
    await board.chat("p", w.id, "tweak it");
    await board.whenIdle();
    expect(existsSync(join(store.outputsDir("p", w.id), "mockups"))).toBe(false);
  } finally {
    delete process.env.FAKE_EXTRA;
  }
});

test("runStartedAt is set while Claude works and cleared after, for runs and chat replies", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Timed", body: "d", status: "backlog" });
  const started: (string | null | undefined)[] = [];
  bus.on((e) => { if (e.type === "ticket.updated" && e.ticket.id === t.id) started.push(e.ticket.runStartedAt); });
  await board.chat("p", t.id, "Shape it");
  expect(store.getTicket("p", t.id)!.runStartedAt).toBeString();
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.runStartedAt).toBeNull();
  expect(started.at(-1)).toBeNull();
  const r = await board.createTicket("p", { title: "Queued", body: "d", status: "ready" });
  expect(store.getTicket("p", r.id)!.runStartedAt).toBeString();
  await board.whenIdle();
  const got = store.getTicket("p", r.id)!;
  expect(got.status).toBe("review");
  expect(got.runStartedAt).toBeNull();
});

test("chat in Review acts right away: In Progress then back to Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.chat("p", t.id, "Please also add tests");
  expect(store.getTicket("p", t.id)!.status).toBe("in_progress");
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("review");
  expect(got.runCount).toBe(2);
  const call = readArgs()[1];
  expect(call.args).toContain("--resume");
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(call.prompt.startsWith("Please also add tests")).toBe(true);
});

const replays = (id: string) =>
  store.readActivity("p", id).map((a: any) => a.event ?? a).filter((e: any) => e.type === "user" && e.isReplay)
    .map((e: any) => e.message.content[0].text as string);

test("chat while Claude works steers the run instead of restarting it", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "200";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await Bun.sleep(400);
    expect(board.isRunning("p", t.id)).toBe(true);
    await board.chat("p", t.id, "also add a test for X");
    await board.chat("p", t.id, "and Y");
    await board.whenIdle();
    expect(readArgs().length).toBe(1);
    const steered = replays(t.id).slice(1);
    expect(steered.map((m) => m.split("\n")[0])).toEqual(["also add a test for X", "and Y"]);
    expect(steered[0]).toContain("<ckanban-context");
    const got = store.getTicket("p", t.id)!;
    expect(got.status).toBe("review");
    expect(got.outcome).toBe("done");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("chat sent while the run is still starting is delivered once claude is up", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  // Worktree setup is still running: there is no claude process yet.
  await board.chat("p", t.id, "early note");
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(replays(t.id).slice(1).map((m) => m.split("\n")[0])).toEqual(["early note"]);
});

test("chat that arrives as the run finishes gets a follow-up reply", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  let sent = false;
  bus.on((e) => {
    if (e.type === "activity" && e.id === t.id && (e.event as any)?.type === "result" && !sent) {
      sent = true;
      board.chat("p", t.id, "late thought");
    }
  });
  await board.whenIdle();
  const calls = readArgs();
  expect(calls.length).toBe(2);
  expect(calls[1].args).toContain("--resume");
  expect(calls[1].prompt.startsWith("late thought")).toBe(true);
  expect(store.getTicket("p", t.id)!.status).toBe("review");
});

test("chat is rejected while Claude is stopping", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "hi");
  await Bun.sleep(300);
  board.stop("p", t.id);
  await expect(board.chat("p", t.id, "again")).rejects.toThrow(/stopping/);
}, 15000);

test("steering messages are saved on the ticket until Claude reads them", async () => {
  await setup();
  process.env.FAKE_STEP_MS = "300";
  try {
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    await Bun.sleep(400);
    const after = await board.chat("p", t.id, "also X");
    expect(after.queued).toMatchObject([{ text: "also X", state: "queued" }]);
    expect(store.getTicket("p", t.id)!.queued).toHaveLength(1);
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.queued).toEqual([]);
    expect(replays(t.id).slice(1).map((m) => m.split("\n")[0])).toEqual(["also X"]);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 15000);

test("Stop keeps unread messages as unsent; send or discard them later", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await Bun.sleep(400);
  await board.chat("p", t.id, "first");
  await board.chat("p", t.id, "second");
  board.stop("p", t.id);
  await board.whenIdle();
  const q = store.getTicket("p", t.id)!.queued!;
  expect(q.map((m) => [m.text, m.state])).toEqual([["first", "unsent"], ["second", "unsent"]]);

  board.discardQueued("p", t.id, q[1].id);
  expect(store.getTicket("p", t.id)!.queued!.map((m) => m.text)).toEqual(["first"]);

  process.env.FAKE_MODE = "ok";
  await board.sendQueued("p", t.id, q[0].id);
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.queued).toEqual([]);
  const calls = readArgs();
  expect(calls.at(-1)!.prompt.startsWith("first")).toBe(true);
  expect(() => board.discardQueued("p", t.id, q[0].id)).toThrow(/not found/);
}, 15000);

test("daemon restart keeps unread messages and delivers them after recovery", async () => {
  await setup();
  process.env.FAKE_MODE = "slow";
  const work = await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await Bun.sleep(400);
  await board.chat("p", work.id, "keep going with Y");
  await board.shutdown();
  expect(store.getTicket("p", work.id)!.queued).toMatchObject([{ text: "keep going with Y", state: "queued" }]);
  // A chat reply that was cut off too, on a ticket recover() does not resume.
  const chatTicket = await board.createTicket("p", { title: "chat", body: "", status: "review" });
  store.updateTicket("p", chatTicket.id, { queued: [{ id: "m1", text: "what about Z?", at: new Date().toISOString(), state: "queued" }] });

  process.env.FAKE_MODE = "ok";
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false });
  board.recover();
  await board.whenIdle();
  expect(store.getTicket("p", work.id)!.queued).toEqual([]);
  expect(replays(work.id).some((m) => m.startsWith("keep going with Y"))).toBe(true);
  expect(store.getTicket("p", chatTicket.id)!.queued).toEqual([]);
  expect(readArgs().some((c) => c.prompt?.startsWith("what about Z?"))).toBe(true);
}, 20000);

test("refine chat does not take a queue slot", async () => {
  await setup({ maxParallel: 1 });
  process.env.FAKE_MODE = "slow";
  const a = await board.createTicket("p", { title: "plan", body: "", status: "backlog" });
  await board.chat("p", a.id, "hi");
  const b = await board.createTicket("p", { title: "work", body: "", status: "ready" });
  await Bun.sleep(300);
  expect(store.getTicket("p", b.id)!.status).toBe("in_progress");
}, 15000);

test("last ticket event after a chat reply reports it idle", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  const seen: boolean[] = [];
  bus.on((e) => { if (e.type === "ticket.updated" && e.ticket.id === t.id) seen.push(board.isRunning("p", t.id)); });
  await board.chat("p", t.id, "hi");
  await board.whenIdle();
  expect(seen[0]).toBe(true);
  expect(seen.at(-1)).toBe(false);
});

test("creating a ticket in Planning starts the refine interview automatically", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "app idea", body: "gym tracker", status: "planning" });
  expect(board.isRunning("p", t.id)).toBe(true);
  await board.whenIdle();
  const call = readArgs()[0];
  expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("plan");
  expect(call.prompt.startsWith("<ckanban-context")).toBe(true);
  expect(call.prompt).toContain("gym tracker");
  const got = store.getTicket("p", t.id)!;
  expect(got.refineStarted).toBe(true);
  expect(got.status).toBe("planning");
});

test("moving into Planning auto-starts only the first time; Backlog never does", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  await board.updateTicket("p", t.id, { status: "backlog" });
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
});

test("a manual refine chat also counts as started", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.chat("p", t.id, "thoughts?");
  await board.whenIdle();
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
});

test("linking a session moves the card to Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  const linked = await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  expect(linked.status).toBe("review");
});

test("linked ticket moved into Planning does not auto-start an interview", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  await board.updateTicket("p", t.id, { status: "planning" });
  await board.whenIdle();
  expect(readArgs().length).toBe(0);
});

test("chat still works while the linked session is open in a terminal", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "backlog" });
  await board.linkSession("p", t.id, "11111111-2222-3333-4444-555555555555");
  liveSessions.add("11111111-2222-3333-4444-555555555555");
  await board.chat("p", t.id, "what's the status?");
  await board.whenIdle();
  expect(readArgs().length).toBe(1);
  expect(store.getTicket("p", t.id)!.outcome).not.toBe("blocked");
});

test("planning-only message in Review: Claude marks it and the card moves to Planning", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_EXTRA = '\n1. idea\n<ckanban-move to="planning"/>';
  try {
    await board.chat("p", t.id, "Audit the UI and list 5 improvements. Don't change anything yet.");
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  const got = store.getTicket("p", t.id)!;
  expect(got.status).toBe("planning");
  expect(got.outcome).toBeNull();
  const prompt = readArgs()[1].prompt;
  expect(prompt).toContain('<ckanban-move to="planning"/>');
});

test("normal Review chat still lands back in Review", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  await board.chat("p", t.id, "make the button blue");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.status).toBe("review");
});

test("streams Claude's text as draft events without persisting them", async () => {
  await setup();
  const drafts: string[] = [];
  bus.on((e) => { if (e.type === "draft") drafts.push(e.text); });
  process.env.FAKE_STREAM_DELAY = "200";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  delete process.env.FAKE_STREAM_DELAY;
  expect(drafts.length).toBeGreaterThan(0);
  expect(drafts.some((d) => d.startsWith("Work "))).toBe(true);
  expect(drafts.at(-1)).toBe("");
  expect(store.readActivity("p", t.id).some((a) => a.event?.type === "stream_event")).toBe(false);
});

test("prompts get image file paths; deleting the ticket deletes its images", async () => {
  await setup({ git: false });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const { saveAttachment } = await import("../src/server/attachments");
  const inBody = saveAttachment(store.attachmentsDir, "image/png", png);
  const inComment = saveAttachment(store.attachmentsDir, "image/png", png);
  const other = saveAttachment(store.attachmentsDir, "image/png", png);
  const t = await board.createTicket("p", { title: "x", body: `see ![image](/api/attachments/${inBody})`, status: "ready" });
  await board.whenIdle();
  const prompt = readArgs()[0].prompt;
  expect(prompt).toContain(join(store.attachmentsDir, inBody));
  expect(prompt).toContain("Read tool");
  store.addComment("p", t.id, "user", `![image](/api/attachments/${inComment})`);
  await board.deleteTicket("p", t.id);
  expect(existsSync(join(store.attachmentsDir, inBody))).toBe(false);
  expect(existsSync(join(store.attachmentsDir, inComment))).toBe(false);
  expect(existsSync(join(store.attachmentsDir, other))).toBe(true);
});

test("a finished run lands on top of Review; dragging to Ready keeps the drop slot", async () => {
  await setup();
  const old = await board.createTicket("p", { title: "old", body: "", status: "review" });
  await board.createTicket("p", { title: "older", body: "", status: "review" });
  const t = await board.createTicket("p", { title: "new", body: "", status: "ready" });
  await board.whenIdle();
  const review = store.listTickets("p").filter((x) => x.status === "review").map((x) => x.title);
  expect(review).toEqual(["new", "older", "old"]);
  await board.updateTicket("p", old.id, { order: 100 });
  expect(store.getTicket("p", old.id)!.order).toBe(100);
  await board.updateTicket("p", t.id, { status: "backlog", order: 7 });
  expect(store.getTicket("p", t.id)!.order).toBe(7);
});
