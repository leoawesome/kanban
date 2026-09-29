import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let argsFile: string;

async function setup(opts: { git?: boolean; maxParallel?: number } = {}): Promise<Profile> {
  const path = opts.git === false ? tempDir("ck-plain-") : await makeRepo();
  const p: Profile = {
    name: "P", slug: "p", path, baseBranch: "main", maxParallel: opts.maxParallel ?? 1,
    model: null, createdAt: new Date().toISOString(),
  };
  store.saveProfile(p);
  return p;
}

function readArgs(): { args: string[]; cwd: string }[] {
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  board = new Board(store, bus, { claudeBin: FAKE });
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_PR = "https://github.com/x/y/pull/7";
});

afterEach(async () => {
  board.stopAll();
  await board.whenIdle();
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_PR;
  delete process.env.FAKE_ARGS_FILE;
});

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
  expect(store.readActivity("p", t.id).length).toBe(4);
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
  const prompt = calls[1].args[calls[1].args.indexOf("-p") + 1];
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
  const prompt = readArgs()[0].args[1];
  expect(prompt).toContain("NOT a git repository");
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
