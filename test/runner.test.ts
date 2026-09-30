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
  expect(seen.filter((e) => e.type !== "stream_event").length).toBe(4);
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
  const first = buildArgs("u1", false, "sonnet");
  expect(first).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--include-partial-messages", "--permission-mode", "bypassPermissions", "--session-id", "u1", "--model", "sonnet"]);
  const again = buildArgs("u1", true, null);
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

const STREAM = buildArgs("u1", false, null);

test("messages sent mid-run reach Claude at its next step, in order", async () => {
  process.env.FAKE_STEP_MS = "150";
  try {
    const h = startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "do it", onEvent: () => {} });
    await Bun.sleep(100);
    expect(h.send("also A")).toBe(true);
    expect(h.send("also B")).toBe(true);
    const r = await h.done;
    expect(r.code).toBe(0);
    const replays = r.events.filter((e) => e.type === "user" && e.isReplay).map((e) => e.message.content[0].text);
    expect(replays).toEqual(["do it", "also A", "also B"]);
    expect(r.events.filter((e) => e.type === "result").length).toBe(1);
    expect(r.events.at(-1).result).toContain("Steered: also A | also B");
    expect(h.send("too late")).toBe(false);
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
});

test("a message that lands after Claude's result gets its own turn before exit", async () => {
  let h: ReturnType<typeof startRun>;
  let sent = false;
  h = startRun({
    bin: FAKE, cwd: tempDir(), args: STREAM, input: "do it",
    // Sent while the final message is being written, i.e. just before the result line.
    onEvent: (e) => {
      if (e.type === "assistant" && e.message.content[0]?.type === "text" && !sent) sent = h.send("one more thing");
    },
  });
  const r = await h.done;
  expect(sent).toBe(true);
  expect(r.code).toBe(0);
  const results = r.events.filter((e) => e.type === "result");
  expect(results.length).toBe(2);
  expect(results[1].result).toContain("Reply: one more thing");
});

test("run without follow-ups exits once Claude has answered", async () => {
  const t0 = Date.now();
  const r = await startRun({ bin: FAKE, cwd: tempDir(), args: STREAM, input: "hi", onEvent: () => {} }).done;
  expect(r.code).toBe(0);
  expect(Date.now() - t0).toBeLessThan(5000);
});
