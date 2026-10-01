import { afterEach, beforeEach, expect, test } from "bun:test";
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
let notes: string[];

beforeEach(async () => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  notes = [];
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, notify: (t) => notes.push(t), planWakeDelayMs: 300 });
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 5, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_ARGS_FILE = join(tempDir("ck-args-"), "args.jsonl");
  delete process.env.FAKE_PR;
});

afterEach(async () => {
  await board.shutdown();
  delete process.env.FAKE_BLOCK_MATCH;
  delete process.env.FAKE_STEP_MS;
}, 15000);

/** Wait until no run is left and no wake-up is pending. */
async function settle(ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    await board.whenIdle();
    await Bun.sleep(500);
    if (!(board as any).runs.size) return;
    if (Date.now() > end) throw new Error("plan did not settle");
  }
}

test("a plan runs its children in dependency order, at most maxConcurrent at once, then the final check", async () => {
  process.env.FAKE_STEP_MS = "40";
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  const mk = (title: string, planKey: string, dependsOn?: string[]) =>
    board.createTicket("p", { title, body: "", status: "backlog", parentId: planner.id, planKey, dependsOn });
  const a = await mk("A", "a");
  const b = await mk("B", "b", ["a"]);
  const c = await mk("C", "c", ["a"]);
  const d = await mk("D", "d", ["b", "c"]);
  const e = await mk("E", "e");
  const order: string[] = [];
  const live = new Set<string>();
  let peak = 0;
  bus.on((ev) => {
    if (ev.type !== "ticket.updated" || ev.ticket.parentId !== planner.id) return;
    if (ev.ticket.status === "in_progress" && !live.has(ev.ticket.id)) {
      live.add(ev.ticket.id);
      order.push(ev.ticket.title);
      peak = Math.max(peak, live.size);
    } else if (ev.ticket.status !== "in_progress") live.delete(ev.ticket.id);
  });

  board.startPlan("p", planner.id);
  expect(store.getTicket("p", b.id)!.mode).toBe("auto");
  await settle();

  expect(order.slice(0, 2).sort()).toEqual(["A", "E"]);
  expect(order.at(-1)).toBe("D");
  expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
  expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  expect(peak).toBeLessThanOrEqual(2);
  for (const k of [a, b, c, d, e]) expect(store.getTicket("p", k.id)!.outcome).toBe("done");
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("done");
  // Wake-ups put the planner back in its column and leave its own PR link alone.
  expect(p.status).toBe("backlog");
  expect(p.prUrl).toBeNull();
  // Only the final check woke the planner.
  expect(p.plan?.wakeups).toBe(1);
  expect(notes).toEqual(["Plan done: Plan"]);
});

test("children failing together wake the planner once; an unresolved dead end makes the plan stuck", async () => {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  await board.createTicket("p", { title: "X-fail", body: "", status: "backlog", parentId: planner.id });
  await board.createTicket("p", { title: "Y-fail", body: "", status: "backlog", parentId: planner.id });
  // Child runs (their prompt has "# Ticket: <title>") end blocked; the planner answers "done", so the dead end shows.
  process.env.FAKE_BLOCK_MATCH = "# Ticket: ";
  board.startPlan("p", planner.id);
  await settle();
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.wakeups).toBe(1);
  expect(p.plan?.state).toBe("stuck");
  expect(p.plan?.reason).toContain("nothing can run");
  expect(notes).toEqual(["Plan stuck: Plan"]);
  const wake = store.listComments("p", planner.id).find((c) => c.text.startsWith("Plan stuck"));
  expect(wake).toBeDefined();
});

test("startPlan refuses cycles and plans without children", async () => {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog" });
  expect(() => board.startPlan("p", planner.id)).toThrow(/no child tickets/);
  await board.createTicket("p", { title: "X", body: "", status: "backlog", parentId: planner.id, planKey: "x", dependsOn: ["y"] });
  await board.createTicket("p", { title: "Y", body: "", status: "backlog", parentId: planner.id, planKey: "y", dependsOn: ["x"] });
  expect(() => board.startPlan("p", planner.id)).toThrow(/dependency cycle/);
  expect(store.getTicket("p", planner.id)!.plan).toBeUndefined();
});
