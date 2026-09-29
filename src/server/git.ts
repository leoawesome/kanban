import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Profile } from "./types";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], cwd: string): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message };
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const r = await run(["git", "rev-parse", "--is-inside-work-tree"], path);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function detectBaseBranch(path: string): Promise<string> {
  const origin = await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path);
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim().replace(/^origin\//, "");
  const cur = await run(["git", "branch", "--show-current"], path);
  if (cur.code === 0 && cur.stdout.trim()) return cur.stdout.trim();
  return "main";
}

export function worktreeDir(profile: Pick<Profile, "path" | "slug">, id: string): string {
  return join(dirname(profile.path), ".ckanban-worktrees", profile.slug, id);
}

export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  mkdirSync(dirname(dir), { recursive: true });
  const exists = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
  const args = exists ? ["git", "worktree", "add", dir, branch] : ["git", "worktree", "add", "-b", branch, dir, base];
  const r = await run(args, repo);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
}

export async function removeWorktree(repo: string, dir: string): Promise<{ removed: boolean; reason?: string }> {
  if (!existsSync(dir)) return { removed: true };
  const status = await run(["git", "status", "--porcelain"], dir);
  if (status.code !== 0) return { removed: false, reason: status.stderr.trim() };
  if (status.stdout.trim()) return { removed: false, reason: "worktree has uncommitted changes" };
  const r = await run(["git", "worktree", "remove", dir], repo);
  if (r.code !== 0) return { removed: false, reason: r.stderr.trim() };
  return { removed: true };
}

export async function which(bin: string): Promise<boolean> {
  return Bun.which(bin) !== null;
}
