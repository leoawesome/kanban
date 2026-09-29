#!/usr/bin/env bun
// Fake `claude` CLI for tests. Behaviour controlled by env:
// FAKE_MODE=ok|fail|slow|blocked|noresult, FAKE_PR=<url>, FAKE_ARGS_FILE=<path to append argv JSON>
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
}
const mode = process.env.FAKE_MODE ?? "ok";
const idx = Math.max(args.indexOf("--session-id"), args.indexOf("--resume"));
const sessionId = idx >= 0 ? args[idx + 1] : "none";

const stepMs = Number(process.env.FAKE_STEP_MS ?? 0);

function emit(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (mode === "fail") {
  process.stderr.write("boom: something failed\n");
  process.exit(1);
}

emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });

// one event split across two chunks to exercise line buffering
const split = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${process.cwd()}/src/app.ts` } }] } }) + "\n";
process.stdout.write(split.slice(0, 20));
await Bun.sleep(20);
process.stdout.write(split.slice(20));
process.stdout.write("not json line\n");

if (stepMs) {
  for (const cmd of ["npm install", "npm test"]) {
    await Bun.sleep(stepMs);
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: cmd, name: "Bash", input: { command: cmd } }] } });
    await Bun.sleep(stepMs);
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: cmd, content: `ok: ${cmd}` }] } });
  }
}

if (mode === "child") {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  if (process.env.FAKE_CHILD_PID_FILE) appendFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
  await Bun.sleep(30000);
}

if (mode === "slow") {
  await Bun.sleep(30000);
}

const pr = process.env.FAKE_PR ?? null;
const status = mode === "blocked" ? "blocked" : "done";
const text = mode === "noresult"
  ? "All done, no result line."
  : `Work complete.\nCKANBAN_RESULT: ${JSON.stringify({ status, prUrl: pr, summary: `fake ${status}` })}`;
emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
emit({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 100, session_id: sessionId });
