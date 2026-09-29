import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";

let store: Store;
const profile: Profile = {
  name: "Demo", slug: "demo", path: "/tmp/demo", baseBranch: "main",
  maxParallel: 1, model: null, createdAt: "2026-09-29T00:00:00.000Z",
};

beforeEach(() => {
  store = new Store(mkdtempSync(join(tmpdir(), "ck-store-")));
  store.saveProfile(profile);
});

test("config defaults", () => {
  expect(store.config()).toEqual({ port: 7777, prPollMinutes: 5 });
});

test("profile CRUD", () => {
  expect(store.listProfiles().map((p) => p.slug)).toEqual(["demo"]);
  expect(store.getProfile("demo")?.name).toBe("Demo");
  store.saveProfile({ ...profile, maxParallel: 3 });
  expect(store.getProfile("demo")?.maxParallel).toBe(3);
  store.deleteProfile("demo");
  expect(store.getProfile("demo")).toBeNull();
});

test("ticket round-trip with tricky title", () => {
  const title = `He said: "hi" — ✨`;
  const t = store.createTicket("demo", { title, body: "line1\n---\nline2", status: "backlog" });
  const got = store.getTicket("demo", t.id)!;
  expect(got.title).toBe(title);
  expect(got.body).toBe("line1\n---\nline2");
  expect(got.status).toBe("backlog");
  expect(got.outcome).toBeNull();
  expect(store.listTickets("demo").length).toBe(1);
});

test("order increments within column", () => {
  const a = store.createTicket("demo", { title: "a", body: "", status: "ready" });
  const b = store.createTicket("demo", { title: "b", body: "", status: "ready" });
  const c = store.createTicket("demo", { title: "c", body: "", status: "backlog" });
  expect(b.order).toBe(a.order + 1);
  expect(c.order).toBe(1);
});

test("updateTicket keeps body edited externally on disk", () => {
  const t = store.createTicket("demo", { title: "x", body: "old", status: "planning" });
  const file = store.ticketPath("demo", t.id);
  const raw = readFileSync(file, "utf8").replace(/old\s*$/, "new plan from claude\n");
  writeFileSync(file, raw);
  const u = store.updateTicket("demo", t.id, { status: "ready" });
  expect(u.body.trim()).toBe("new plan from claude");
  expect(store.getTicket("demo", t.id)!.body.trim()).toBe("new plan from claude");
  expect(u.status).toBe("ready");
});

test("comments append in order", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  store.addComment("demo", t.id, "user", "first");
  store.addComment("demo", t.id, "ai", "second");
  expect(store.listComments("demo", t.id).map((c) => [c.author, c.text])).toEqual([
    ["user", "first"], ["ai", "second"],
  ]);
});

test("activity append/read", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  store.appendActivity("demo", t.id, 1, { type: "system" });
  store.appendActivity("demo", t.id, 1, { type: "result" });
  const a = store.readActivity("demo", t.id);
  expect(a.map((e) => e.event.type)).toEqual(["system", "result"]);
  expect(a[0].run).toBe(1);
});

test("corrupt ticket listed with error", () => {
  const dir = join(store.root, "profiles", "demo", "tickets", "t_bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), "garbage without frontmatter");
  const list = store.listTickets("demo");
  const bad = list.find((t) => t.id === "t_bad")!;
  expect(bad.error).toStartWith("corrupt");
});
