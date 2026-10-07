import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus, type BusEvent } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { matchSnippets, replaceQuery, snippetQuery } from "../web/src/snippetText";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;
const events: BusEvent[] = [];

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  bus.on((e) => events.push(e));
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
  for (const slug of ["alpha", "beta"]) {
    store.saveProfile({ name: slug, slug, path: tempDir("ck-p-"), baseBranch: "main", maxParallel: 1, createdAt: new Date().toISOString() } as any);
  }
});

afterAll(() => server.stop(true));

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

test("snippet CRUD, board scoping and persistence", async () => {
  let r = await call("POST", "/snippets", { name: "e2e", text: "Run e2e tests before finishing.", scope: "global" });
  expect(r.status).toBe(201);
  const g = (await r.json()) as any;
  expect(g).toMatchObject({ name: "e2e", scope: "global", text: "Run e2e tests before finishing." });
  expect(events.some((e) => e.type === "snippets.updated")).toBe(true);

  r = await call("POST", "/snippets", { name: "@ui-check", text: "Screenshot it.", scope: "alpha" });
  expect(r.status).toBe(201);
  const a = (await r.json()) as any;
  expect(a.name).toBe("ui-check");

  const names = async (q: string) => ((await (await call("GET", `/snippets${q}`)).json()) as any[]).map((s) => s.name);
  expect(await names("?profile=alpha")).toEqual(["e2e", "ui-check"]);
  expect(await names("?profile=beta")).toEqual(["e2e"]);
  expect(await names("")).toEqual(["e2e", "ui-check"]);

  r = await call("PATCH", `/snippets/${a.id}`, { text: "Screenshot light and dark.", scope: "global" });
  expect(r.status).toBe(200);
  expect(await names("?profile=beta")).toEqual(["e2e", "ui-check"]);

  const saved = JSON.parse(readFileSync(join(store.root, "snippets.json"), "utf8"));
  expect(saved.find((s: any) => s.id === a.id).text).toBe("Screenshot light and dark.");

  r = await call("DELETE", `/snippets/${a.id}`);
  expect(r.status).toBe(204);
  expect(await names("?profile=beta")).toEqual(["e2e"]);
  expect((await call("DELETE", `/snippets/${a.id}`)).status).toBe(404);
  expect((await call("PATCH", "/snippets/nope", { text: "x" })).status).toBe(404);
  expect(g.id).toBeTruthy();
});

test("snippet validation", async () => {
  const bad = async (body: unknown, status = 400) => {
    const r = await call("POST", "/snippets", body);
    expect(r.status).toBe(status);
    return ((await r.json()) as any).error as string;
  };
  expect(await bad({ name: "", text: "x" })).toContain("name is required");
  expect(await bad({ name: "Bad Name", text: "x" })).toContain("lowercase");
  expect(await bad({ name: "-dash", text: "x" })).toContain("lowercase");
  expect(await bad({ name: "a".repeat(41), text: "x" })).toContain("too long");
  expect(await bad({ name: "ok", text: "  " })).toContain("text is required");
  expect(await bad({ name: "ok", text: "x", scope: "nope" })).toContain("not found");

  expect((await call("POST", "/snippets", { name: "dup", text: "x", scope: "alpha" })).status).toBe(201);
  // Same name in another scope is fine; twice in one scope is not.
  expect((await call("POST", "/snippets", { name: "dup", text: "y", scope: "global" })).status).toBe(201);
  expect(await bad({ name: "dup", text: "z", scope: "alpha" }, 409)).toContain("already exists");
  const list = (await (await call("GET", "/snippets?profile=alpha")).json()) as any[];
  const other = list.find((s) => s.name === "e2e");
  expect((await call("PATCH", `/snippets/${other.id}`, { name: "dup" })).status).toBe(409);
});

test("deleting a board drops its snippets", async () => {
  expect((await call("POST", "/snippets", { name: "only-beta", text: "x", scope: "beta" })).status).toBe(201);
  expect((await call("DELETE", "/profiles/beta")).status).toBe(204);
  const all = (await (await call("GET", "/snippets")).json()) as any[];
  expect(all.some((s) => s.scope === "beta")).toBe(false);
  expect(existsSync(join(store.root, "snippets.json"))).toBe(true);
});

test("snippetQuery triggers only on @ at a word start", () => {
  expect(snippetQuery("@", 1)).toEqual({ start: 0, query: "" });
  expect(snippetQuery("hi @e2", 6)).toEqual({ start: 3, query: "e2" });
  expect(snippetQuery("line\n@ui-ch", 11)).toEqual({ start: 5, query: "ui-ch" });
  expect(snippetQuery("(@e", 3)).toEqual({ start: 1, query: "e" });
  expect(snippetQuery("mail leo@example", 16)).toBeNull();
  expect(snippetQuery("@e2e done", 9)).toBeNull();
  expect(snippetQuery("@E", 2)).toBeNull();
  expect(snippetQuery("no at", 5)).toBeNull();
});

test("matchSnippets prefers prefix matches; replaceQuery swaps @query for the text", () => {
  const s = (name: string) => ({ id: name, name, text: `${name} text`, scope: "global", createdAt: "", updatedAt: "" });
  const list = [s("no-deps"), s("e2e"), s("ui-e2e"), s("deploy")];
  expect(matchSnippets(list, "e").map((x) => x.name)).toEqual(["e2e", "no-deps", "ui-e2e", "deploy"]);
  expect(matchSnippets(list, "e2").map((x) => x.name)).toEqual(["e2e", "ui-e2e"]);
  expect(matchSnippets(list, "zzz")).toEqual([]);
  expect(matchSnippets(list, "").length).toBe(4);
  expect(replaceQuery("Fix it. @e", 8, 10, "Run tests.")).toEqual({ value: "Fix it. Run tests.", caret: 18 });
  expect(replaceQuery("@e and more", 0, 2, "Run tests.")).toEqual({ value: "Run tests. and more", caret: 10 });
});
