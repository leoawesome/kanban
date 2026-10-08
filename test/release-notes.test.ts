import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseNotes } from "../scripts/release-notes";

const log = `# Changelog

## Unreleased

### Added
- next thing

## [0.2.0] - 2026-10-02

### Added
- second

### Fixed
- a bug

## [0.1.0] - 2026-10-01

First release.

[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.com/tag/v0.1.0
`;

test("releaseNotes returns one version's section, with or without the v prefix", () => {
  expect(releaseNotes(log, "v0.2.0")).toBe("### Added\n- second\n\n### Fixed\n- a bug");
  expect(releaseNotes(log, "0.2.0")).toBe(releaseNotes(log, "v0.2.0"));
});

test("the last section stops before the link references", () => {
  expect(releaseNotes(log, "v0.1.0")).toBe("First release.");
});

test("missing versions and Unreleased give null", () => {
  expect(releaseNotes(log, "v0.3.0")).toBeNull();
  expect(releaseNotes(log, "Unreleased")).toBeNull();
  expect(releaseNotes("## [0.4.0] - 2026-10-03\n\n## [0.3.0]\n- x", "0.4.0")).toBeNull();
});

test("the repo's CHANGELOG has notes for the current package version or an Unreleased section", () => {
  const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  expect(releaseNotes(changelog, version) !== null || changelog.includes("\n## Unreleased")).toBe(true);
});
