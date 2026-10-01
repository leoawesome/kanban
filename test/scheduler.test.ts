import { afterEach, beforeEach, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { fillTitle, Scheduler } from "../src/server/scheduler";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let store: Store;
let board: Board;
let bus: Bus;
let now: Date;
let scheduler: Scheduler;
let events: BusEvent[];

const at = (h: number, mi = 0, s = 0) => new Date(2026, 9, 1, h, mi, s);
const scheduled = () => store.listTickets("p").filter((t) => t.scheduleId);

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  now = at(8, 30);
  scheduler = new Scheduler(board, store, bus, () => now);
});

afterEach(() => board.whenIdle());

const create = (extra: Record<string, unknown> = {}) =>
  scheduler.create("p", { name: "Audit", title: "Audit {date}", body: "check deps", cron: "0 9 * * *", ...extra });

test("create validates and computes the next run", () => {
  const s = create();
  expect(s).toMatchObject({ enabled: true, skipIfRunning: true, mode: "auto", lastFiredAt: null });
  expect(new Date(s.nextRunAt!)).toEqual(at(9));
  expect(store.getSchedule("p", s.id)).toEqual(s);
  expect(events.some((e) => e.type === "schedule.updated" && e.id === s.id)).toBe(true);
  expect(() => create({ cron: "61 * * * *" })).toThrow("invalid cron expression: minute 61 is out of range");
  expect(() => create({ name: " " })).toThrow("name is required");
  expect(() => create({ title: "" })).toThrow("ticket title is required");
});

test("tick does nothing before the due time, then fires once", async () => {
  const s = create();
  await scheduler.tick();
  expect(scheduled()).toHaveLength(0);

  now = at(9, 0, 10);
  await scheduler.tick();
  await scheduler.tick();
  const tickets = scheduled();
  expect(tickets).toHaveLength(1);
  expect(tickets[0]).toMatchObject({ title: "Audit 2026-10-01", body: "check deps", mode: "auto", scheduleId: s.id });
  const after = store.getSchedule("p", s.id)!;
  expect(after.lastFiredAt).toBe(now.toISOString());
  expect(new Date(after.nextRunAt!)).toEqual(new Date(2026, 9, 2, 9));
  const h = scheduler.history("p", s.id);
  expect(h).toHaveLength(1);
  expect(h[0]).toMatchObject({ kind: "fired", trigger: "schedule", ticketId: tickets[0].id });
  expect(h[0].ticket?.id).toBe(tickets[0].id);
});

test("several missed slots fire exactly one catch-up run", async () => {
  const s = create({ cron: "*/5 * * * *" });
  expect(new Date(s.nextRunAt!)).toEqual(at(8, 35));
  // Daemon was off from 08:30 to 09:12: 8 slots missed.
  now = at(9, 12);
  await scheduler.tick();
  await scheduler.tick();
  expect(scheduled()).toHaveLength(1);
  expect(scheduler.history("p", s.id)[0]).toMatchObject({ kind: "fired", trigger: "missed" });
  expect(new Date(store.getSchedule("p", s.id)!.nextRunAt!)).toEqual(at(9, 15));
});

test("skips while the previous ticket is still queued", async () => {
  const s = create({ cron: "*/5 * * * *" });
  const prev = store.createTicket("p", { title: "prev", body: "", status: "ready", scheduleId: s.id });
  now = at(8, 35);
  await scheduler.tick();
  expect(scheduled()).toHaveLength(1);
  expect(scheduler.history("p", s.id)[0]).toMatchObject({ kind: "skipped", ticketId: prev.id });
  expect(store.getSchedule("p", s.id)!.lastFiredAt).toBeNull();

  // Finished previous run: the next slot fires.
  store.updateTicket("p", prev.id, { status: "review" });
  now = at(8, 40);
  await scheduler.tick();
  expect(scheduled()).toHaveLength(2);
});

test("skipIfRunning off fires even when the previous ticket is queued", async () => {
  const s = create({ skipIfRunning: false });
  store.createTicket("p", { title: "prev", body: "", status: "ready", scheduleId: s.id });
  await scheduler.runNow("p", s.id);
  expect(scheduled()).toHaveLength(2);
});

test("paused schedules never fire and resuming does not backfill", async () => {
  const s = create();
  const paused = scheduler.update("p", s.id, { enabled: false });
  expect(paused.nextRunAt).toBeNull();
  now = at(12);
  await scheduler.tick();
  expect(scheduled()).toHaveLength(0);

  const resumed = scheduler.update("p", s.id, { enabled: true });
  expect(new Date(resumed.nextRunAt!)).toEqual(new Date(2026, 9, 2, 9));
  await scheduler.tick();
  expect(scheduled()).toHaveLength(0);
});

test("editing the name keeps the pending slot; editing the cron recomputes it", () => {
  const s = create();
  now = at(8, 45);
  expect(scheduler.update("p", s.id, { name: "Renamed" }).nextRunAt).toBe(s.nextRunAt);
  expect(new Date(scheduler.update("p", s.id, { cron: "50 8 * * *" }).nextRunAt!)).toEqual(at(8, 50));
});

test("run now fires immediately without moving the next run", async () => {
  const s = create();
  const entry = await scheduler.runNow("p", s.id);
  expect(entry).toMatchObject({ kind: "fired", trigger: "manual" });
  expect(scheduled()).toHaveLength(1);
  expect(store.getSchedule("p", s.id)!.nextRunAt).toBe(s.nextRunAt);
});

test("a fire that cannot create its ticket records the error on the schedule", async () => {
  const s = create();
  store.saveProfile({ ...store.getProfile("p")!, path: "/definitely/not/here" });
  const entry = await scheduler.runNow("p", s.id);
  expect(entry.kind).toBe("error");
  expect(store.getSchedule("p", s.id)!.lastError).toContain("does not exist");
  expect(scheduled()).toHaveLength(0);

  store.saveProfile({ ...store.getProfile("p")!, path: tempDir() });
  await scheduler.runNow("p", s.id);
  expect(store.getSchedule("p", s.id)!.lastError).toBeNull();
});

test("history shows the ticket's current status, and null once it is deleted", async () => {
  const s = create();
  await scheduler.runNow("p", s.id);
  await board.whenIdle();
  const [e] = scheduler.history("p", s.id);
  // /bin/false exits non-zero: the run fails like a real failed run would.
  expect(e.ticket?.outcome).toBe("failed");
  await board.deleteTicket("p", e.ticket!.id);
  expect(scheduler.history("p", s.id)[0].ticket).toBeNull();
});

test("remove deletes the schedule and its history", async () => {
  const s = create();
  await scheduler.runNow("p", s.id);
  scheduler.remove("p", s.id);
  expect(store.getSchedule("p", s.id)).toBeNull();
  expect(store.readScheduleHistory("p", s.id)).toEqual([]);
  expect(() => scheduler.get("p", s.id)).toThrow("not found");
});

test("fillTitle", () => {
  expect(fillTitle("Report {date} {time}", new Date(2026, 0, 5, 7, 3))).toBe("Report 2026-01-05 07:03");
});
