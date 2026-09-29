import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDefaults, encodeProjectDir, listClaudeProjects } from "../src/server/claude";
import { tempDir } from "./helpers";

function fixture() {
  const home = tempDir("ck-home-");
  const configDir = join(home, ".claude");
  const work = tempDir("ck-work-");
  const older = join(work, "older-app");
  const newer = join(work, "new.app");
  const neverRun = join(work, "never-run");
  for (const d of [older, newer, neverRun]) mkdirSync(d);
  const gone = join(work, "deleted");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    projects: { [older]: {}, [newer]: {}, [neverRun]: {}, [gone]: {}, "/private/tmp/scratch": {} },
  }));
  mkdirSync(join(configDir, "projects", encodeProjectDir(older)), { recursive: true });
  mkdirSync(join(configDir, "projects", encodeProjectDir(newer)), { recursive: true });
  utimesSync(join(configDir, "projects", encodeProjectDir(older)), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(configDir, "projects", encodeProjectDir(newer)), new Date("2026-09-01"), new Date("2026-09-01"));
  return { home, configDir, older, newer, neverRun };
}

test("encodeProjectDir matches Claude's folder naming", () => {
  expect(encodeProjectDir("/Users/leo/dev/my.app")).toBe("-Users-leo-dev-my-app");
});

test("listClaudeProjects: existing dirs, newest session first, tmp excluded", () => {
  const f = fixture();
  const list = listClaudeProjects({ homeDir: f.home, configDir: f.configDir, excludePrefixes: ["/private/tmp/"] });
  expect(list.map((p) => p.path)).toEqual([f.newer, f.older, f.neverRun]);
  expect(list[0].name).toBe("new.app");
  expect(list[0].lastUsed).toBe(new Date("2026-09-01").toISOString());
  expect(list[2].lastUsed).toBeNull();
});

test("listClaudeProjects: missing ~/.claude.json gives empty list", () => {
  expect(listClaudeProjects({ homeDir: tempDir(), configDir: tempDir() })).toEqual([]);
});

test("claudeDefaults reads model from settings.json", () => {
  const configDir = tempDir();
  expect(claudeDefaults({ configDir })).toEqual({ model: null });
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
  expect(claudeDefaults({ configDir })).toEqual({ model: "opus[1m]" });
  writeFileSync(join(configDir, "settings.json"), "{broken");
  expect(claudeDefaults({ configDir })).toEqual({ model: null });
});

import { listSessions, liveSessionMatch } from "../src/server/claude";

test("listSessions reads titles, first prompt, newest first", () => {
  const configDir = tempDir();
  const project = "/Users/x/dev/app";
  const dir = join(configDir, "projects", encodeProjectDir(project));
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
  const b = join(dir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
  writeFileSync(a, [
    JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Base directory for this skill: /x/skills/y" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Improve OpenSearch message status" } }),
    JSON.stringify({ type: "custom-title", customTitle: "old name", sessionId: "a" }),
    JSON.stringify({ type: "custom-title", customTitle: "OS improvement planning", sessionId: "a" }),
    "not json",
  ].join("\n"));
  writeFileSync(b, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Fix the queue" }] } }) + "\n");
  utimesSync(a, new Date("2026-09-01"), new Date("2026-09-01"));
  utimesSync(b, new Date("2026-09-02"), new Date("2026-09-02"));
  const list = listSessions(project, { configDir });
  expect(list.map((s) => s.id)).toEqual(["bbbbbbbb-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000001"]);
  expect(list[1]).toMatchObject({ title: "OS improvement planning", firstPrompt: "Improve OpenSearch message status" });
  expect(list[0]).toMatchObject({ title: null, firstPrompt: "Fix the queue" });
  expect(listSessions("/nope", { configDir })).toEqual([]);
});

test("liveSessionMatch finds claude processes by id or title", () => {
  const ps = [
    "/usr/bin/zsh",
    "claude --resume OS improvement planning",
    "node /opt/claude/cli.js -r aaaaaaaa-0000-0000-0000-000000000001",
    "vim notes.txt --resume x",
  ];
  expect(liveSessionMatch(ps, { id: "zzz", title: "OS improvement planning" })).toBe(true);
  expect(liveSessionMatch(ps, { id: "aaaaaaaa-0000-0000-0000-000000000001", title: null })).toBe(true);
  expect(liveSessionMatch(ps, { id: "bbbb", title: "Other" })).toBe(false);
  expect(liveSessionMatch(["vim --resume Other"], { id: "bbbb", title: "Other" })).toBe(false);
});
