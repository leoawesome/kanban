#!/usr/bin/env bun
// Fake `claude` CLI for tests. Behaviour controlled by env:
// FAKE_MODE=ok|fail|slow|partial|blocked|noresult|background|bgsilent, FAKE_PR=<url>, FAKE_ARGS_FILE=<path to append argv JSON>
// With --input-format stream-json it reads user messages from stdin like the real CLI: messages that
// arrive mid-run are picked up at the next step (replayed with --replay-user-messages), later ones
// get their own turn, and it exits at end of input.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const streamIn = args.includes("--input-format");
const replay = args.includes("--replay-user-messages");

const inbox: string[] = [];
let eof = false;
let wake = (): void => {};
if (streamIn) {
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    const line = (l: string) => {
      if (!l.trim()) return;
      const m = JSON.parse(l);
      inbox.push(m.message.content.map((c: any) => c.text ?? "").join(""));
    };
    for await (const chunk of Bun.stdin.stream()) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      wake();
    }
    line(buf);
    eof = true;
    wake();
  })();
}
async function nextMessage(): Promise<string | null> {
  while (!inbox.length && !eof) await new Promise<void>((r) => (wake = r));
  return inbox.shift() ?? null;
}
const heard: string[] = [];
function take(text: string) {
  heard.push(text);
  if (replay) emit({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, isReplay: true });
}
/** Pick up messages sent while "working", as the real CLI does between steps. */
function drain() {
  while (inbox.length) take(inbox.shift()!);
}

const first = streamIn ? await nextMessage() : null;
if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd(), prompt: first }) + "\n");
}
// FAKE_BLOCK_MATCH: runs whose first prompt contains this text end "blocked" (per-ticket behaviour in one test).
const mode = process.env.FAKE_BLOCK_MATCH && first?.includes(process.env.FAKE_BLOCK_MATCH) ? "blocked" : process.env.FAKE_MODE ?? "ok";
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
if (first !== null) take(first);

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
    drain();
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

// Starts writing its reply, then hangs (a restart cuts it off mid-reply).
if (mode === "partial") {
  emit({ type: "stream_event", event: { type: "message_start" } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half a repl" } } });
  await Bun.sleep(30000);
}

const pr = process.env.FAKE_PR ?? null;
if (process.env.FAKE_OUTPUT && process.env.CKANBAN_OUTPUT_DIR) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${process.env.CKANBAN_OUTPUT_DIR}/report.md`, process.env.FAKE_OUTPUT);
}

// Leaves a task running in the background past its result, like a long Bash call Claude backgrounded.
const bgMs = Number(process.env.FAKE_BG_MS ?? 300);
const background = mode === "background" || mode === "bgsilent";
if (background) emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "Count timeouts" }] });

drain();
const steered = heard.slice(1);
const status = mode === "blocked" ? "blocked" : mode === "questions" ? "questions" : "done";
const text = mode === "noresult"
  ? "All done, no result line."
  : `Work complete.${steered.length ? `\nSteered: ${steered.join(" | ")}` : ""}${process.env.FAKE_EXTRA ?? ""}\nCKANBAN_RESULT: ${JSON.stringify({ status, prUrl: pr, summary: `fake ${status}` })}`;
for (const chunk of ["Work ", "complete."]) {
  if (process.env.FAKE_STREAM_DELAY) await Bun.sleep(Number(process.env.FAKE_STREAM_DELAY));
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } } });
}
emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
emit({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 100, session_id: sessionId });

// The real CLI kills background tasks at end of input; otherwise it starts a turn when one finishes
// (bgsilent: it doesn't, so the board has to end input itself).
if (background) {
  const t0 = Date.now();
  while (!eof && Date.now() - t0 < bgMs) await Bun.sleep(10);
  const status = eof ? "killed" : "completed";
  emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  emit({ type: "system", subtype: "task_notification", task_id: "bg1", status });
  if (!eof && mode === "background") {
    emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
    const reply = `Background result: ${status}\nCKANBAN_RESULT: ${JSON.stringify({ status: "done", prUrl: pr, summary: "bg done" })}`;
    emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
  }
}

// Messages that arrive after the turn ended get a turn of their own.
while (streamIn) {
  const next = await nextMessage();
  if (next === null) break;
  take(next);
  const reply = `Reply: ${next}\nCKANBAN_RESULT: ${JSON.stringify({ status: "done", prUrl: pr, summary: `reply ${next}` })}`;
  emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
}
