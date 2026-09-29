import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/server/git";

export function tempDir(prefix = "ck-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function makeRepo(): Promise<string> {
  const dir = tempDir("ck-repo-");
  await run(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hi\n");
  await run(["git", "add", "."], dir);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  return dir;
}
