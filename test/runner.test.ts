import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildArgs, startRun } from "../src/server/runner";
import { tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

function withMode(mode: string, fn: () => Promise<void>) {
  return async () => {
    process.env.FAKE_MODE = mode;
    try { await fn(); } finally { delete process.env.FAKE_MODE; }
  };
}

test("ok run collects events and skips non-json lines", withMode("ok", async () => {
  const seen: any[] = [];
  const h = startRun({ bin: FAKE, cwd: tempDir(), args: ["-p", "x"], onEvent: (e) => seen.push(e) });
  const r = await h.done;
  expect(r.code).toBe(0);
  expect(r.events.map((e) => e.type)).toEqual(["system", "assistant", "assistant", "result"]);
  expect(seen.length).toBe(4);
  expect(r.events[1].message.content[0].name).toBe("Edit");
}));

test("fail run returns code and stderr tail", withMode("fail", async () => {
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: [], onEvent: () => {} }).done;
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("boom");
}));

test("stop terminates slow run", withMode("slow", async () => {
  const h = startRun({ bin: FAKE, cwd: tempDir(), args: [], onEvent: () => {} });
  await Bun.sleep(300);
  const t0 = Date.now();
  h.stop();
  const r = await h.done;
  expect(Date.now() - t0).toBeLessThan(7000);
  expect(r.code).not.toBe(0);
  expect(h.stopped).toBe(true);
}), 10000);

test("missing binary resolves with error", async () => {
  const r = await startRun({ bin: "/nonexistent/claude", cwd: tempDir(), args: [], onEvent: () => {} }).done;
  expect(r.code).not.toBe(0);
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("buildArgs", () => {
  const first = buildArgs("hello", "u1", false, "sonnet");
  expect(first).toEqual(["-p", "hello", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "bypassPermissions", "--session-id", "u1", "--model", "sonnet"]);
  const again = buildArgs("hello", "u1", true, null);
  expect(again).toContain("--resume");
  expect(again).not.toContain("--session-id");
  expect(again).not.toContain("--model");
});

test("stop kills the whole process group (grandchildren too)", async () => {
  const pidFile = join(tempDir(), "child.pid");
  process.env.FAKE_MODE = "child";
  process.env.FAKE_CHILD_PID_FILE = pidFile;
  try {
    const h = startRun({ bin: FAKE, cwd: tempDir(), args: [], onEvent: () => {} });
    await Bun.sleep(600);
    const childPid = Number(await Bun.file(pidFile).text());
    expect(childPid).toBeGreaterThan(0);
    h.stop();
    await h.done;
    await Bun.sleep(200);
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_CHILD_PID_FILE;
  }
}, 10000);
