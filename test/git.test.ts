import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { makeRepo } from "./helpers";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, detectBaseBranch, isGitRepo, removeWorktree, run, worktreeDir } from "../src/server/git";

let repo: string;

beforeAll(async () => {
  repo = await makeRepo();
});

test("isGitRepo", async () => {
  expect(await isGitRepo(repo)).toBe(true);
  expect(await isGitRepo(mkdtempSync(join(tmpdir(), "ck-plain-")))).toBe(false);
});

test("detectBaseBranch", async () => {
  expect(await detectBaseBranch(repo)).toBe("main");
});

test("worktreeDir location", () => {
  const d = worktreeDir({ path: "/a/b/repo", slug: "p" } as any, "t_1");
  expect(d).toBe("/a/b/.ckanban-worktrees/p/t_1");
});

test("add and remove clean worktree", async () => {
  const dir = join(repo + "-wt", "t1");
  await addWorktree(repo, dir, "ck/t1-x", "main");
  expect(existsSync(join(dir, "README.md"))).toBe(true);
  const r = await run(["git", "branch", "--show-current"], dir);
  expect(r.stdout.trim()).toBe("ck/t1-x");
  expect(await removeWorktree(repo, dir)).toEqual({ removed: true });
  expect(existsSync(dir)).toBe(false);
});

test("dirty worktree not removed", async () => {
  const dir = join(repo + "-wt", "t2");
  await addWorktree(repo, dir, "ck/t2-x", "main");
  writeFileSync(join(dir, "new.txt"), "x");
  const r = await removeWorktree(repo, dir);
  expect(r.removed).toBe(false);
  expect(existsSync(dir)).toBe(true);
});

test("addWorktree failure throws with stderr", async () => {
  await expect(addWorktree(repo, join(repo + "-wt", "t3"), "ck/t3", "nope-branch")).rejects.toThrow();
});
