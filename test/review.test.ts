import { expect, test } from "bun:test";
import { buildTree, isReviewComments, reviewKey, reviewMessage, treeOrder } from "../web/src/review";

test("reviewMessage lists every comment with path:line, the quoted code and the text", () => {
  const msg = reviewMessage([
    { id: "2", path: "web/src/api.ts", line: 9, code: "  return x;", text: "Return a copy.\nAnd log it." },
    { id: "1", path: "src/server/usage.ts", line: 43, code: "t.days = groupByDay(rows);", text: "Group by local day." },
  ]);
  expect(msg).toBe([
    "Review comments on your changes (2 comments). Please address each one:",
    "",
    "1. `src/server/usage.ts:43`",
    "   > t.days = groupByDay(rows);",
    "   Group by local day.",
    "",
    "2. `web/src/api.ts:9`",
    "   > return x;",
    "   Return a copy.",
    "   And log it.",
  ].join("\n"));
  expect(reviewMessage([{ id: "1", path: "a", line: 1, code: "", text: "x" }])).toContain("(1 comment)");
});

test("buildTree groups by folder, folders first, and merges single-folder chains", () => {
  const files = ["src/server/usage.ts", "src/server/csv.ts", "web/src/api.ts", "README.md", "test/csv.test.ts"].map((path) => ({ path }));
  const tree = buildTree(files);
  expect(tree.dirs.map((d) => d.name)).toEqual(["src/server", "test", "web/src"]);
  expect(tree.dirs[0].files.map((f) => f.path)).toEqual(["src/server/csv.ts", "src/server/usage.ts"]);
  expect(tree.dirs[0].path).toBe("src/server");
  expect(tree.files.map((f) => f.path)).toEqual(["README.md"]);
  expect(treeOrder(tree).map((f) => f.path)).toEqual([
    "src/server/csv.ts", "src/server/usage.ts", "test/csv.test.ts", "web/src/api.ts", "README.md",
  ]);
});

test("buildTree keeps a folder that has files and subfolders", () => {
  const tree = buildTree([{ path: "a/x.ts" }, { path: "a/b/y.ts" }]);
  expect(tree.dirs[0]).toMatchObject({ name: "a", files: [{ path: "a/x.ts" }] });
  expect(tree.dirs[0].dirs[0]).toMatchObject({ name: "b", path: "a/b" });
});

test("review comments storage", () => {
  expect(reviewKey("kanban", "t_1")).toBe("ckanban.review.kanban.t_1");
  expect(isReviewComments([{ id: "1", path: "a", line: 1, code: "", text: "x" }])).toBe(true);
  expect(isReviewComments([{ path: "a" }])).toBe(false);
  expect(isReviewComments("nope")).toBe(false);
});
