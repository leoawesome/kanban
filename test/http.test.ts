import { afterAll, beforeAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer, isAllowedRequest } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(() => {
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const json = (method: string, body?: unknown) => ({
  method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

test("isAllowedRequest", () => {
  expect(isAllowedRequest(new Request("http://localhost:7777/api/x"), 7777)).toBe(true);
  expect(isAllowedRequest(new Request("http://127.0.0.1:7777/api/x"), 7777)).toBe(true);
  expect(isAllowedRequest(new Request("http://evil.com:7777/api/x"), 7777)).toBe(false);
  const cross = new Request("http://localhost:7777/api/x", { method: "POST", headers: { origin: "http://evil.com" } });
  expect(isAllowedRequest(cross, 7777)).toBe(false);
  const same = new Request("http://localhost:7777/api/x", { method: "POST", headers: { origin: "http://localhost:7777" } });
  expect(isAllowedRequest(same, 7777)).toBe(true);
});

test("rejects foreign Host header", async () => {
  const r = await fetch(`${base}/api/profiles`, { headers: { host: "evil.com" } });
  expect(r.status).toBe(403);
});

test("rejects cross-origin POST", async () => {
  const r = await fetch(`${base}/api/profiles`, {
    ...json("POST", { name: "x", path: "/tmp" }),
    headers: { "content-type": "application/json", origin: "http://evil.com" },
  });
  expect(r.status).toBe(403);
});

test("profile + ticket flow", async () => {
  const path = tempDir("ck-plain-");
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "My Proj", path }));
  expect(r.status).toBe(201);
  const p = (await r.json()) as any;
  expect(p.slug).toBe("my-proj");
  expect(p.maxParallel).toBe(1);

  r = await fetch(`${base}/api/profiles`, json("POST", { name: "My Proj", path }));
  expect(((await r.json()) as any).slug).toBe("my-proj-2");

  r = await fetch(`${base}/api/profiles/my-proj/tickets`, json("POST", { title: "Hello", body: "b" }));
  expect(r.status).toBe(201);
  const t = (await r.json()) as any;
  expect(t.status).toBe("backlog");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}`, json("PATCH", { status: "planning" }));
  expect(((await r.json()) as any).status).toBe("planning");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}/comments`, json("POST", { text: "hi" }));
  expect(r.status).toBe(201);

  r = await fetch(`${base}/api/profiles/my-proj/tickets`);
  const list = (await r.json()) as any;
  expect(list.length).toBe(1);
  expect(list[0].running).toBe(false);

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}/comments`);
  expect(((await r.json()) as any)[0].text).toBe("hi");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}`, { method: "DELETE" });
  expect(r.status).toBe(204);
});

test("validation and 404s", async () => {
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "x", path: "/definitely/missing" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/nope/tickets`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/profiles/my-proj-2/tickets/t_nope`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/profiles/my-proj-2/tickets`, json("POST", { title: "" }));
  expect(r.status).toBe(400);
});

test("rejects non-JSON content-type on mutations (form posts)", async () => {
  const r = await fetch(`${base}/api/profiles`, {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "x", path: "/tmp" }),
  });
  expect(r.status).toBe(415);
});

test("stale body edit returns 409", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Conflict", path }));
  const t = (await (await fetch(`${base}/api/profiles/conflict/tickets`, json("POST", { title: "t", body: "a" }))).json()) as any;
  await fetch(`${base}/api/profiles/conflict/tickets/${t.id}`, json("PATCH", { body: "b" }));
  const r = await fetch(`${base}/api/profiles/conflict/tickets/${t.id}`, json("PATCH", { body: "c", expectedBody: "a" }));
  expect(r.status).toBe(409);
});

test("health", async () => {
  const r = await fetch(`${base}/api/health`);
  const h = (await r.json()) as any;
  expect(typeof h.git).toBe("boolean");
});
