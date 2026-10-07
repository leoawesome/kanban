import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/server/git";
import { parseSession } from "../src/server/session";
import type { Profile } from "../src/server/types";
import {
  applyDetection, copySetupFiles, detectSetup, parseSetupBlock, prepareWorktree, runShell, withSetup, type SetupResult,
} from "../src/server/worktree-setup";
import { makeRepo, tempDir } from "./helpers";

function write(root: string, rel: string, text = "x\n") {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

async function commit(repo: string) {
  await run(["git", "add", "-A"], repo);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"], repo);
}

test("detects git-ignored .env files in the root and first-level folders, never node_modules or build output", async () => {
  const repo = await makeRepo();
  write(repo, ".gitignore", ".env\n.env.local\nnode_modules/\ndist/\nweb/.env\ndeep/a/.env\n");
  write(repo, ".env.example");
  await commit(repo);
  write(repo, ".env");
  write(repo, ".env.local");
  write(repo, "web/.env");
  write(repo, "web/index.ts");
  write(repo, "deep/a/.env");
  write(repo, "node_modules/x/.env");
  write(repo, "node_modules/.env");
  write(repo, "dist/.env");
  const d = await detectSetup(repo);
  expect(d.copyFiles).toEqual([".env", ".env.local", "web/.env"]);
});

test("setup command from lockfiles in the root and first-level folders, joined with &&", async () => {
  const repo = await makeRepo();
  write(repo, "bun.lock");
  write(repo, "web/bun.lockb");
  write(repo, "api/poetry.lock");
  write(repo, "api/uv.lock");
  write(repo, "site/package-lock.json");
  write(repo, "site/Gemfile.lock");
  write(repo, "tool/go.mod");
  write(repo, "crate/Cargo.lock");
  write(repo, "node_modules/foo/yarn.lock");
  await commit(repo);
  const d = await detectSetup(repo);
  expect(d.setupCommand).toBe("bun install && (cd api && uv sync) && (cd site && npm ci) && (cd site && bundle install) && (cd web && bun install)");
  expect(d.setupFrom).toEqual(["bun.lock", "api/uv.lock", "site/package-lock.json", "site/Gemfile.lock", "web/bun.lockb"]);
});

test("each lockfile maps to its install command", async () => {
  const cases: [string, string][] = [
    ["bun.lock", "bun install"], ["bun.lockb", "bun install"], ["pnpm-lock.yaml", "pnpm install"], ["yarn.lock", "yarn install"],
    ["package-lock.json", "npm ci"], ["uv.lock", "uv sync"], ["poetry.lock", "poetry install"], ["Gemfile.lock", "bundle install"],
  ];
  for (const [file, cmd] of cases) {
    const repo = await makeRepo();
    write(repo, file);
    expect((await detectSetup(repo)).setupCommand).toBe(cmd);
  }
});

test("git-ignored folders and non-git folders are not scanned", async () => {
  const repo = await makeRepo();
  write(repo, ".gitignore", "generated/\n");
  await commit(repo);
  write(repo, "generated/package-lock.json");
  expect((await detectSetup(repo)).setupCommand).toBe("");
  const plain = tempDir("ck-plain-");
  write(plain, "bun.lock");
  write(plain, ".env");
  expect(await detectSetup(plain)).toMatchObject({ copyFiles: [], setupCommand: "" });
});

test("applyDetection keeps values the user set unless asked to overwrite", () => {
  const p = { name: "p", slug: "p", path: "/x", baseBranch: "main", maxParallel: 1, createdAt: "" } as Profile;
  const d = { at: "t", copyFiles: [".env"], setupCommand: "bun install", setupFrom: ["bun.lock"] };
  expect(applyDetection(p, d)).toMatchObject({ copyFiles: [".env"], setupCommand: "bun install", setupDetected: d });
  expect(applyDetection({ ...p, setupCommand: "make" }, d)).toMatchObject({ setupCommand: "make", setupDetected: d });
  expect(applyDetection({ ...p, setupCommand: "make" }, d, true).setupCommand).toBe("bun install");
});

test("copySetupFiles keeps relative paths, expands globs, skips missing files and ones outside the folder", () => {
  const from = tempDir("ck-from-");
  const to = tempDir("ck-to-");
  write(from, ".env", "A=1\n");
  write(from, "web/.env.local", "B=2\n");
  write(from, "web/.env.test", "C=3\n");
  write(to, "tracked.env", "keep\n");
  write(from, "tracked.env", "overwrite?\n");
  const r = copySetupFiles(from, to, [".env", "web/.env*", "missing.env", "../etc/passwd", "tracked.env"]);
  expect(r.copied).toEqual([".env", "web/.env.local", "web/.env.test"]);
  expect(r.missing).toEqual(["missing.env"]);
  expect(readFileSync(join(to, "web/.env.local"), "utf8")).toBe("B=2\n");
  expect(readFileSync(join(to, "tracked.env"), "utf8")).toBe("keep\n");
});

test("runShell captures output and exit code, and times out", async () => {
  const dir = tempDir();
  const ok = await runShell(dir, "echo out; echo err >&2", { shell: "/bin/sh" });
  expect(ok).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
  expect(ok.output).toContain("out");
  expect(ok.output).toContain("err");
  const bad = await runShell(dir, "echo nope; exit 3", { shell: "/bin/sh" });
  expect(bad).toMatchObject({ ok: false, exitCode: 3 });
  const slow = await runShell(dir, "sleep 5", { shell: "/bin/sh", timeoutMs: 200 });
  expect(slow).toMatchObject({ ok: false, timedOut: true });
  expect(slow.durationMs).toBeLessThan(3000);
});

test("prepareWorktree copies files before running the setup command, and keeps the last 40 lines", async () => {
  const from = tempDir("ck-from-");
  const to = tempDir("ck-to-");
  write(from, ".env", "SECRET=1\n");
  // The fake setup command sees the copied file.
  const r = await prepareWorktree(from, to, { copyFiles: [".env"], setupCommand: "cat .env > seen.txt && seq 1 100" }, { shell: "/bin/sh" });
  expect(readFileSync(join(to, "seen.txt"), "utf8")).toBe("SECRET=1\n");
  expect(r).toMatchObject({ copied: [".env"], ok: true, exitCode: 0 });
  expect(r!.output.split("\n")).toHaveLength(40);
  expect(r!.output.split("\n").at(-1)).toBe("100");
  expect(await prepareWorktree(from, to, {})).toBeNull();
  const failed = await prepareWorktree(from, to, { setupCommand: "echo boom; exit 1" }, { shell: "/bin/sh" });
  expect(failed).toMatchObject({ ok: false, exitCode: 1, output: "boom" });
});

test("setup block round-trips through the prompt and becomes a row in the chat", () => {
  const r: SetupResult = { copied: [".env"], missing: [], command: "bun install", ok: false, exitCode: 1, timedOut: false, output: "error: </ckanban-setup> oops", durationMs: 1200 };
  const prompt = withSetup("Fix the bug\n\n<ckanban-context note=\"Board started work\">do it</ckanban-context>", r);
  expect(prompt).toContain("failed (exit 1)");
  expect(parseSetupBlock(prompt)).toEqual(r);
  const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: prompt } });
  const entry = parseSession(line).entries[0];
  expect(entry).toMatchObject({ kind: "text", text: "Fix the bug", setup: r });
  // A prompt with no board instructions gets its own context tag, so the chat doesn't show the block as typed text.
  const raw = withSetup("hello", { ...r, ok: true, exitCode: 0 });
  const e2 = parseSession(JSON.stringify({ type: "user", uuid: "u2", timestamp: "", message: { role: "user", content: raw } })).entries[0];
  expect(e2).toMatchObject({ text: "hello", setup: { ok: true } });
  expect(withSetup("same", null)).toBe("same");
});
