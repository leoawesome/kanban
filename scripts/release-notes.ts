#!/usr/bin/env bun
// Prints the CHANGELOG.md section for a version, used as the GitHub Release notes.
// Usage: bun scripts/release-notes.ts v0.8.0 [CHANGELOG.md]   (exits 1 when the version has no section)
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The body under `## [<version>]` up to the next `## ` heading, trimmed; null when missing or empty. */
export function releaseNotes(changelog: string, version: string): string | null {
  const v = version.replace(/^v/, "");
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && (l.startsWith("## ") || /^\[[^\]]+\]: /.test(l)));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

if (import.meta.main) {
  const [version, file = join(import.meta.dir, "..", "CHANGELOG.md")] = process.argv.slice(2);
  if (!version) throw new Error("usage: bun scripts/release-notes.ts <version> [CHANGELOG.md]");
  const notes = releaseNotes(readFileSync(file, "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no "## [${version.replace(/^v/, "")}]" section`);
    process.exit(1);
  }
  console.log(notes);
}
