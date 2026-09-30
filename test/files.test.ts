import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileError, listDir, MAX_VIEW_BYTES, readFileForView, resolveInside } from "../src/server/files";
import { makeRepo, tempDir } from "./helpers";

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FileError ? e.status : -1;
  }
  return 0;
};

test("resolveInside rejects .., absolute escapes and symlinks out of root", () => {
  const root = tempDir();
  const outside = tempDir();
  writeFileSync(join(outside, "secret"), "x");
  mkdirSync(join(root, "a"));
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(root, "a"), join(root, "inner"));
  expect(resolveInside(root, "")).toBe(root);
  expect(resolveInside(root, "a")).toBe(join(root, "a"));
  expect(resolveInside(root, "inner")).toBe(join(root, "a"));
  expect(status(() => resolveInside(root, "../x"))).toBe(400);
  expect(status(() => resolveInside(root, "a/../../x"))).toBe(400);
  expect(status(() => resolveInside(root, "link/secret"))).toBe(403);
  expect(status(() => resolveInside(root, "missing"))).toBe(404);
});

test("listDir sorts folders first and hides .git and gitignored entries", async () => {
  const root = await makeRepo();
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n");
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "Zdir"));
  writeFileSync(join(root, "src", "b.ts"), "");
  writeFileSync(join(root, "debug.log"), "");
  writeFileSync(join(root, "a.txt"), "");
  const top = await listDir(root, "");
  expect(top.map((e) => e.name)).toEqual(["src", "Zdir", ".gitignore", "a.txt", "README.md"]);
  expect(top[0]).toEqual({ name: "src", path: "src", type: "dir" });
  expect(await listDir(root, "src")).toEqual([{ name: "b.ts", path: "src/b.ts", type: "file" }]);
});

test("listDir outside a git repo shows everything but .git", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "x.log"), "");
  expect((await listDir(root, "")).map((e) => e.name)).toEqual(["node_modules", "x.log"]);
});

test("readFileForView returns text, flags binary and large files", () => {
  const root = tempDir();
  writeFileSync(join(root, "a.ts"), "const a = 1;\n");
  writeFileSync(join(root, "img.bin"), new Uint8Array([0x89, 0x50, 0, 1]));
  writeFileSync(join(root, "big.txt"), "x".repeat(MAX_VIEW_BYTES + 1));
  expect(readFileForView(root, "a.ts")).toMatchObject({ content: "const a = 1;\n", binary: false, tooLarge: false });
  expect(readFileForView(root, "img.bin")).toMatchObject({ content: null, binary: true });
  expect(readFileForView(root, "big.txt")).toMatchObject({ content: null, tooLarge: true });
  expect(status(() => readFileForView(root, ""))).toBe(400);
});
