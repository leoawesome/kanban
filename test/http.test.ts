import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer, isAllowedRequest } from "../src/server/http";
import { ptySupported } from "../src/server/shell";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
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
  expect(p.maxParallel).toBe(5);

  r = await fetch(`${base}/api/profiles`, json("POST", { name: "My Proj", path }));
  expect(((await r.json()) as any).slug).toBe("my-proj-2");

  r = await fetch(`${base}/api/profiles/my-proj/tickets`, json("POST", { title: "Hello", body: "b" }));
  expect(r.status).toBe(201);
  const t = (await r.json()) as any;
  expect(t.status).toBe("backlog");

  r = await fetch(`${base}/api/profiles/my-proj/tickets/${t.id}`, json("PATCH", { status: "review" }));
  expect(((await r.json()) as any).status).toBe("review");

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

test("claude discovery endpoints respond", async () => {
  const projects = (await (await fetch(`${base}/api/claude/projects`)).json()) as any;
  expect(Array.isArray(projects)).toBe(true);
  const defaults = (await (await fetch(`${base}/api/claude/defaults`)).json()) as any;
  expect("model" in defaults).toBe(true);
});

test("link session endpoint and sessions list", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Linky", path }));
  let r = await fetch(`${base}/api/profiles/linky/sessions`);
  expect(r.status).toBe(200);
  const t = (await (await fetch(`${base}/api/profiles/linky/tickets`, json("POST", {
    title: "linked", status: "review", sessionId: "11111111-2222-3333-4444-555555555555",
  }))).json()) as any;
  expect(t.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(t.status).toBe("review");
  expect(t.resumeCommand).toContain(`--resume 11111111-2222-3333-4444-555555555555`);
  const conv = (await (await fetch(`${base}/api/profiles/linky/tickets/${t.id}/conversation`)).json()) as any;
  expect(conv).toMatchObject({ entries: [], total: 0 });
  r = await fetch(`${base}/api/profiles/linky/tickets/${t.id}/link-session`, json("POST", { sessionId: "bad" }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/linky/tickets/${t.id}/link-session`, json("POST", { sessionId: null }));
  expect(((await r.json()) as any).sessionId).toBeNull();
});

test("new tickets default to interview mode; outputs are served as sandboxed text", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Modes", path }));
  const t = (await (await fetch(`${base}/api/profiles/modes/tickets`, json("POST", { title: "t" }))).json()) as any;
  expect(t.mode).toBe("interview");
  const a = (await (await fetch(`${base}/api/profiles/modes/tickets`, json("POST", { title: "t2", mode: "auto" }))).json()) as any;
  expect(a.mode).toBe("auto");
  const patched = (await (await fetch(`${base}/api/profiles/modes/tickets/${t.id}`, json("PATCH", { mode: "auto" }))).json()) as any;
  expect(patched.mode).toBe("auto");
  expect(await (await fetch(`${base}/api/profiles/modes/tickets/${t.id}/outputs`)).json()).toEqual([]);
  const r = await fetch(`${base}/api/profiles/modes/tickets/${t.id}/outputs/..%2Fticket.md`);
  expect(r.status).toBe(404);
});

test("chat endpoint validates and conflicts", async () => {
  const path = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Chatty", path }));
  const t = (await (await fetch(`${base}/api/profiles/chatty/tickets`, json("POST", { title: "t", status: "backlog" }))).json()) as any;
  let r = await fetch(`${base}/api/profiles/chatty/tickets/${t.id}/chat`, json("POST", { text: " " }));
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/chatty/tickets/${t.id}/chat`, json("POST", { text: "hello" }));
  expect(r.status).toBe(202);
  expect(((await r.json()) as any).running).toBe(true);
  r = await fetch(`${base}/api/profiles/chatty/tickets/${t.id}/chat`, json("POST", { text: "again" }));
  expect([202, 409]).toContain(r.status);
});

test("inbox lists tickets across boards where Claude needs the user, not Review", async () => {
  const a = tempDir("ck-plain-");
  const b = tempDir("ck-plain-");
  await fetch(`${base}/api/profiles`, json("POST", { name: "Inbox A", path: a }));
  await fetch(`${base}/api/profiles`, json("POST", { name: "Inbox B", path: b }));
  const failed = (await (await fetch(`${base}/api/profiles/inbox-a/tickets`, json("POST", { title: "broken", status: "backlog" }))).json()) as any;
  store.updateTicket("inbox-a", failed.id, { status: "planning", outcome: "failed", error: "boom" });
  const review = (await (await fetch(`${base}/api/profiles/inbox-b/tickets`, json("POST", { title: "check me", status: "backlog" }))).json()) as any;
  store.updateTicket("inbox-b", review.id, { status: "review", outcome: "done" });
  const inbox = (await (await fetch(`${base}/api/inbox`)).json()) as any[];
  const mine = inbox.filter((i) => i.profile.startsWith("inbox-"));
  expect(mine).toEqual([{ profile: "inbox-a", profileName: "Inbox A", id: failed.id, title: "broken", attention: { kind: "failed", label: "Run failed" } }]);
});

test("health", async () => {
  const r = await fetch(`${base}/api/health`);
  const h = (await r.json()) as any;
  expect(typeof h.git).toBe("boolean");
});

test("attachments: upload, serve, and reject bad input", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  expect(r.status).toBe(201);
  const { url, path } = (await r.json()) as any;
  expect(url).toMatch(/^\/api\/attachments\/[0-9a-f]{32}\.png$/);
  expect(path).toBe(join(store.attachmentsDir, url.split("/").pop()));
  r = await fetch(`${base}${url}`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(png);

  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
  expect(r.status).toBe(415);
  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: "not a png" });
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(10 * 1024 * 1024 + 1) });
  expect(r.status).toBe(413);
  r = await fetch(`${base}/api/attachments/..%2Fconfig.json`);
  expect(r.status).toBe(404);
  r = await fetch(`${base}/api/attachments`, {
    method: "POST", headers: { "content-type": "image/png", origin: "http://evil.com" }, body: png,
  });
  expect(r.status).toBe(403);
});

test("files API lists and reads inside the profile, rejects escapes", async () => {
  const path = tempDir("ck-files-");
  await Bun.write(join(path, "hello.ts"), "export {};\n");
  const r0 = await fetch(`${base}/api/profiles`, json("POST", { name: "Files", path }));
  const { slug } = (await r0.json()) as any;
  let r = await fetch(`${base}/api/profiles/${slug}/files?path=`);
  expect(((await r.json()) as any).entries).toEqual([{ name: "hello.ts", path: "hello.ts", type: "file" }]);
  r = await fetch(`${base}/api/profiles/${slug}/file?path=hello.ts`);
  expect(((await r.json()) as any).content).toBe("export {};\n");
  r = await fetch(`${base}/api/profiles/${slug}/file?path=${encodeURIComponent("../etc/passwd")}`);
  expect(r.status).toBe(400);
  r = await fetch(`${base}/api/profiles/${slug}/files?path=${encodeURIComponent("/etc")}`);
  expect(r.status).toBe(404);
});

const openSocket = (url: string, origin: string) =>
  new Promise<{ ok: boolean; ws: WebSocket }>((resolve) => {
    const ws = new WebSocket(url, { headers: { origin } } as any);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve({ ok: true, ws });
    ws.onerror = () => resolve({ ok: false, ws });
    ws.onclose = () => resolve({ ok: false, ws });
  });

test("shell socket rejects a foreign Origin", async () => {
  const r0 = await fetch(`${base}/api/profiles`, json("POST", { name: "Sock", path: tempDir("ck-sock-") }));
  const { slug } = (await r0.json()) as any;
  const port = server.port;
  const { ok } = await openSocket(`ws://localhost:${port}/api/profiles/${slug}/shell`, "http://evil.com");
  expect(ok).toBe(false);
  const r = await fetch(`${base}/api/profiles/${slug}/shell`, { headers: { host: `localhost:${port}` } });
  expect(r.status).toBe(ptySupported() ? 403 : 501);
});

test.skipIf(!ptySupported())("shell socket runs commands on a PTY and replays output on reconnect", async () => {
  const path = tempDir("ck-shell-");
  const r0 = await fetch(`${base}/api/profiles`, json("POST", { name: "Shell", path }));
  const { slug } = (await r0.json()) as any;
  const port = server.port;
  const url = `ws://localhost:${port}/api/profiles/${slug}/shell?cols=90&rows=20`;
  const origin = `http://localhost:${port}`;
  const read = (ws: WebSocket, want: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      const dec = new TextDecoder();
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") out += dec.decode(e.data as ArrayBuffer);
        if (out.includes(want)) resolve(out);
      };
    });
  const a = await openSocket(url, origin);
  expect(a.ok).toBe(true);
  const got = read(a.ws, "MARK-90");
  a.ws.send(JSON.stringify({ type: "input", data: "tty; pwd; echo MARK-$(tput cols)\n" }));
  const out = await got;
  expect(out).toContain("/dev/ttys");
  expect(out).toContain(path);
  a.ws.close();

  const b = await openSocket(url, origin);
  expect(await read(b.ws, "MARK-90")).toContain("MARK-90");
  b.ws.send(JSON.stringify({ type: "input", data: "exit\n" }));
  b.ws.close();
}, 15_000);

test("cron preview", async () => {
  let r = await fetch(`${base}/api/cron/preview?expr=${encodeURIComponent("0 9 * * 1-5")}`);
  const ok = (await r.json()) as any;
  expect(ok).toMatchObject({ valid: true, error: null, summary: "Weekdays at 09:00" });
  expect(ok.next).toHaveLength(3);
  r = await fetch(`${base}/api/cron/preview?expr=${encodeURIComponent("* *")}`);
  expect(((await r.json()) as any)).toMatchObject({ valid: false, next: [] });
});

test("schedule CRUD, run now and history", async () => {
  let r = await fetch(`${base}/api/profiles`, json("POST", { name: "Sched", path: tempDir("ck-sched-") }));
  const slug = ((await r.json()) as any).slug;
  const url = `${base}/api/profiles/${slug}/schedules`;

  r = await fetch(url, json("POST", { name: "Nightly", title: "Audit {date}", body: "go", cron: "nope" }));
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("invalid cron expression");

  r = await fetch(url, json("POST", { name: "Nightly", title: "Audit {date}", body: "go", cron: "0 3 * * *" }));
  expect(r.status).toBe(201);
  const s = (await r.json()) as any;
  expect(s).toMatchObject({ name: "Nightly", enabled: true, summary: "Every day at 03:00", active: false });
  expect(s.nextRunAt).toBeTruthy();

  r = await fetch(`${url}/${s.id}`, json("PATCH", { enabled: false }));
  expect(((await r.json()) as any)).toMatchObject({ enabled: false, nextRunAt: null });

  r = await fetch(`${url}/${s.id}/run`, json("POST"));
  const run = (await r.json()) as any;
  expect(run.entry.kind).toBe("fired");
  const tickets = (await (await fetch(`${base}/api/profiles/${slug}/tickets`)).json()) as any[];
  expect(tickets.find((t) => t.id === run.entry.ticketId)?.scheduleId).toBe(s.id);

  r = await fetch(`${url}/${s.id}/history`);
  const h = (await r.json()) as any[];
  expect(h[0]).toMatchObject({ kind: "fired", trigger: "manual" });
  expect(h[0].ticket.id).toBe(run.entry.ticketId);

  r = await fetch(url);
  expect(((await r.json()) as any[]).map((x) => x.id)).toEqual([s.id]);

  r = await fetch(`${url}/${s.id}`, { method: "DELETE" });
  expect(r.status).toBe(204);
  r = await fetch(`${url}/${s.id}/history`);
  expect(r.status).toBe(404);
});
