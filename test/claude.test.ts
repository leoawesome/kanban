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
