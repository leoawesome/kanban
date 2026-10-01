import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { SessionCache } from "../src/server/session";
import { defaultSpawn, ptySupported, ShellManager } from "../src/server/shell";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

// Stand-in for interactive `claude`: prints its args, writes the session file on the first line typed, then waits.
let server: ReturnType<typeof createServer>;
let shells: ShellManager;
let base: string;
let configDir: string;

beforeAll(() => {
  configDir = tempDir("ck-claude-cfg-");
  const bin = join(tempDir("ck-bin-"), "fake claude");
  writeFileSync(bin, `#!/bin/sh
echo "ARGS $*"
read line
mkdir -p "${configDir}/projects/p"
printf '%s\\n' '{"type":"user","message":{"role":"user","content":"rephrase this"}}' > "${configDir}/projects/p/$2.jsonl"
echo "GOT $line"
sleep 30
`);
  chmodSync(bin, 0o755);
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  shells = new ShellManager(defaultSpawn(bin));
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), shells, sessions: new SessionCache({ configDir }) });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  shells.killAll();
  server.stop(true);
});

const json = (method: string, body?: unknown) => ({
  method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

const openSocket = (url: string, origin: string) =>
  new Promise<{ ok: boolean; ws: WebSocket }>((resolve) => {
    const ws = new WebSocket(url, { headers: { origin } } as any);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve({ ok: true, ws });
    ws.onerror = () => resolve({ ok: false, ws });
    ws.onclose = () => resolve({ ok: false, ws });
  });

const read = (ws: WebSocket, want: RegExp) =>
  new Promise<string>((resolve) => {
    let out = "";
    const dec = new TextDecoder();
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") out += dec.decode(e.data as ArrayBuffer);
      if (want.test(out)) resolve(out);
    };
  });

async function profile(): Promise<string> {
  const r = await fetch(`${base}/api/profiles`, json("POST", { name: "Chat", path: tempDir("ck-chat-") }));
  return ((await r.json()) as any).slug;
}

test("quick chat session endpoint is empty before the chat starts", async () => {
  const slug = await profile();
  const r = await fetch(`${base}/api/profiles/${slug}/claude/session`);
  expect(await r.json()).toEqual({ sessionId: null, running: false, started: false, title: null });
});

test("claude socket rejects a foreign Origin", async () => {
  const slug = await profile();
  const { ok } = await openSocket(`ws://localhost:${server.port}/api/profiles/${slug}/claude`, "http://evil.com");
  expect(ok).toBe(false);
});

test.skipIf(!ptySupported())("quick chat runs claude on a known session, separate from the shell, and can become a ticket", async () => {
  const slug = await profile();
  const origin = `http://localhost:${server.port}`;
  const a = await openSocket(`ws://localhost:${server.port}/api/profiles/${slug}/claude?cols=90&rows=20`, origin);
  expect(a.ok).toBe(true);
  const args = await read(a.ws, /ARGS --session-id [0-9a-f-]{36}/);
  const id = args.match(/--session-id ([0-9a-f-]{36})/)![1];

  let s = (await (await fetch(`${base}/api/profiles/${slug}/claude/session`)).json()) as any;
  expect(s).toMatchObject({ sessionId: id, running: true, started: false });
  expect(shells.current(slug, "shell")).toBeUndefined();

  const got = read(a.ws, /GOT hello/);
  a.ws.send(JSON.stringify({ type: "input", data: "hello\r" }));
  await got;
  s = (await (await fetch(`${base}/api/profiles/${slug}/claude/session`)).json()) as any;
  expect(s).toMatchObject({ sessionId: id, started: true });

  // Reconnecting reattaches to the same chat.
  a.ws.close();
  const b = await openSocket(`ws://localhost:${server.port}/api/profiles/${slug}/claude`, origin);
  expect(await read(b.ws, /GOT hello/)).toContain(id);

  // Make ticket: the existing create-with-session path links it.
  const r = await fetch(`${base}/api/profiles/${slug}/tickets`, json("POST", { title: "Quick chat", body: "", status: "backlog", sessionId: id }));
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ sessionId: id, status: "backlog" });

  // Then the dock restarts the chat on a fresh session.
  const fresh = read(b.ws, /ARGS --session-id/);
  b.ws.send(JSON.stringify({ type: "restart" }));
  const out = await fresh;
  const next = [...out.matchAll(/--session-id ([0-9a-f-]{36})/g)].map((x) => x[1]).at(-1);
  expect(next).not.toBe(id);
  s = (await (await fetch(`${base}/api/profiles/${slug}/claude/session`)).json()) as any;
  expect(s).toMatchObject({ sessionId: next, running: true, started: false });
  b.ws.close();
}, 15_000);

test.skipIf(!ptySupported())("Start again after the chat ended resumes the same session", async () => {
  const slug = await profile();
  const origin = `http://localhost:${server.port}`;
  const a = await openSocket(`ws://localhost:${server.port}/api/profiles/${slug}/claude`, origin);
  const id = (await read(a.ws, /ARGS --session-id [0-9a-f-]{36}/)).match(/--session-id ([0-9a-f-]{36})/)![1];
  const got = read(a.ws, /GOT hi/);
  a.ws.send(JSON.stringify({ type: "input", data: "hi\r" }));
  await got;

  const exited = new Promise<void>((resolve) => {
    a.ws.onmessage = (e) => {
      if (typeof e.data === "string" && JSON.parse(e.data).type === "exit") resolve();
    };
  });
  shells.current(slug, "claude")!.kill();
  await exited;
  expect(((await (await fetch(`${base}/api/profiles/${slug}/claude/session`)).json()) as any).running).toBe(false);

  const back = read(a.ws, /ARGS --resume [0-9a-f-]{36}/);
  a.ws.send(JSON.stringify({ type: "restart", resume: true }));
  expect(await back).toContain(`--resume ${id}`);
  expect(shells.current(slug, "claude")!.sessionId).toBe(id);
  a.ws.close();
}, 15_000);
