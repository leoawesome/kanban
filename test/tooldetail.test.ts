import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { parseSession, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { findToolDetail, TOOL_OUTPUT_MAX } from "../src/server/tooldetail";
import { editDiff, mainInput } from "../web/src/toolView";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (content: any, at: string) => L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content } });
const asst = (content: any[], at: string) => L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content } });

const LONG = `gh run view 37649385086 --log-failed 2>&1 | grep -vE "^\\s*$" | grep -iE "fail|error|expect" | head -30 && git log --oneline -6 origin/main\necho done`;
const RAW = [
  user("Check CI", "2026-10-08T01:00:00Z"),
  asst([{ type: "tool_use", id: "b1", name: "Bash", input: { command: LONG, description: "Failed CI logs" } }], "2026-10-08T01:00:01Z"),
  user([{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text: "1 fail\n412 pass" }] }], "2026-10-08T01:00:02Z"),
  asst([{ type: "tool_use", id: "b2", name: "Bash", input: { command: "bun test" } }], "2026-10-08T01:00:03Z"),
  user([{ type: "tool_result", tool_use_id: "b2", content: "x".repeat(TOOL_OUTPUT_MAX + 50), is_error: true }], "2026-10-08T01:00:04Z"),
  asst([{ type: "tool_use", id: "b3", name: "Bash", input: { command: "sleep 100" } }], "2026-10-08T01:00:05Z"),
].join("\n");

test("parseSession: tool rows carry their tool_use id and whether they failed", () => {
  const tools = parseSession(RAW).entries.filter((e) => e.kind === "tool");
  expect(tools.map((e) => [e.toolUseId, e.error ?? false])).toEqual([["b1", false], ["b2", true], ["b3", false]]);
  // The label stays clipped; the full command comes from the tool endpoint.
  expect(tools[0].text.length).toBeLessThan(LONG.length);
});

test("findToolDetail: full input, output, error and truncation", () => {
  expect(findToolDetail(RAW, "b1")).toEqual({
    id: "b1", name: "Bash", input: { command: LONG, description: "Failed CI logs" }, output: "1 fail\n412 pass", isError: false, truncated: false,
  });
  const failed = findToolDetail(RAW, "b2")!;
  expect(failed).toMatchObject({ isError: true, truncated: true });
  expect(failed.output!.length).toBe(TOOL_OUTPUT_MAX);
  // Still running: no result yet.
  expect(findToolDetail(RAW, "b3")).toMatchObject({ output: null, isError: false });
  expect(findToolDetail(RAW, "nope")).toBeNull();
});

test("tool endpoint returns one call in full; 404 for unknown ids", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-666666666666";
  writeFileSync(join(dir, `${sid}.jsonl`), RAW + "\n");
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), sessions: new SessionCache({ configDir }) });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
    const t = store.createTicket("p", { title: "x", body: "", status: "review" });
    store.updateTicket("p", t.id, { sessionId: sid });
    const d = (await (await fetch(`${base}/api/profiles/p/tickets/${t.id}/tool/b1`)).json()) as any;
    expect(d.input.command).toBe(LONG);
    expect(d.output).toBe("1 fail\n412 pass");
    expect((await fetch(`${base}/api/profiles/p/tickets/${t.id}/tool/nope`)).status).toBe(404);
    // The conversation itself doesn't ship inputs or outputs.
    const conv = await (await fetch(`${base}/api/profiles/p/tickets/${t.id}/conversation`)).text();
    expect(conv).not.toContain("412 pass");
    expect(conv).not.toContain("echo done");
  } finally {
    server.stop(true);
  }
});

test("mainInput: the main argument for known tools, JSON for the rest", () => {
  expect(mainInput({ name: "Bash", input: { command: LONG, description: "x" } })).toBe(LONG);
  expect(mainInput({ name: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b" } })).toBe("/a.ts");
  expect(mainInput({ name: "Grep", input: { pattern: "foo", path: "src" } })).toBe('{\n  "pattern": "foo",\n  "path": "src"\n}');
});

test("editDiff: Edit, MultiEdit and Write as removed/added lines", () => {
  expect(editDiff({ name: "Edit", input: { old_string: "a\nb", new_string: "c" } })!.lines).toEqual([
    { kind: "rm", text: "a" }, { kind: "rm", text: "b" }, { kind: "ad", text: "c" },
  ]);
  expect(editDiff({ name: "MultiEdit", input: { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } })!.lines.map((l) => l.kind))
    .toEqual(["rm", "ad", "gap", "rm", "ad"]);
  expect(editDiff({ name: "Write", input: { content: "x\ny" } })!.lines).toEqual([{ kind: "ad", text: "x" }, { kind: "ad", text: "y" }]);
  expect(editDiff({ name: "Write", input: { content: "z\n".repeat(10_000) } })!.truncated).toBe(true);
  expect(editDiff({ name: "Bash", input: { command: "ls" } })).toBeNull();
});
