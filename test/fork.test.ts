import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forkSessionFile, rewriteSession } from "../src/server/fork";
import { tempDir } from "./helpers";

const o = { fromId: "old", toId: "new", fromCwd: "/a/wt", toCwd: "/a/wt2" };

test("rewriteSession swaps the session id and folder, keeps other lines as they are", () => {
  const raw = [
    JSON.stringify({ type: "user", sessionId: "old", cwd: "/a/wt" }),
    JSON.stringify({ type: "user", sessionId: "old", cwd: "/a/wt/sub" }),
    JSON.stringify({ type: "user", sessionId: "other", cwd: "/a/wtx" }),
    "not json",
    "",
  ].join("\n");
  expect(rewriteSession(raw, o).split("\n")).toEqual([
    JSON.stringify({ type: "user", sessionId: "new", cwd: "/a/wt2" }),
    JSON.stringify({ type: "user", sessionId: "new", cwd: "/a/wt2/sub" }),
    JSON.stringify({ type: "user", sessionId: "other", cwd: "/a/wtx" }),
    "not json",
    "",
  ]);
  expect(rewriteSession('{"t":"x.png"}', { ...o, rename: { "x.png": "y.png" } })).toBe('{"t":"y.png"}');
});

test("forkSessionFile writes into the new folder's project dir with the side folder, never over an existing session", () => {
  const config = tempDir("ck-claude-");
  const from = tempDir("ck-from-");
  const to = tempDir("ck-to-");
  const srcDir = join(config, "projects", from.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(join(srcDir, "old", "subagents"), { recursive: true });
  writeFileSync(join(srcDir, "old", "subagents", "a.jsonl"), "{}\n");
  writeFileSync(join(srcDir, "old.jsonl"), JSON.stringify({ sessionId: "old", cwd: from }) + "\n");
  const dest = forkSessionFile(join(srcDir, "old.jsonl"), { fromId: "old", toId: "new", fromCwd: from, toCwd: to }, config);
  expect(dest).toBe(join(config, "projects", to.replace(/[^a-zA-Z0-9]/g, "-"), "new.jsonl"));
  expect(JSON.parse(readFileSync(dest, "utf8"))).toEqual({ sessionId: "new", cwd: to });
  expect(existsSync(join(dest, "..", "new", "subagents", "a.jsonl"))).toBe(true);
  expect(() => forkSessionFile(join(srcDir, "old.jsonl"), { fromId: "old", toId: "new", fromCwd: from, toCwd: to }, config)).toThrow("already exists");
});
