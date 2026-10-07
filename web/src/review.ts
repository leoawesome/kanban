/** Changes tab helpers (kept free of React/DOM so they can be unit tested). */
import { REVIEW_PREFIX } from "./drafts";

export interface ReviewComment {
  id: string;
  path: string;
  /** Line number in the worktree version of the file. */
  line: number;
  /** The code on that line when the comment was written. */
  code: string;
  text: string;
}

export const reviewKey = (slug: string, ticketId: string) => `${REVIEW_PREFIX}${slug}.${ticketId}`;

export const isReviewComments = (v: unknown): v is ReviewComment[] =>
  Array.isArray(v) && v.every((c) => c && typeof c.path === "string" && typeof c.line === "number" && typeof c.text === "string");

/** The one chat message that hands the user's line comments to Claude. */
export function reviewMessage(comments: ReviewComment[]): string {
  const sorted = comments.slice().sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const parts = sorted.map((c, i) => {
    const quote = c.code.trim() ? `\n   > ${c.code.trim()}` : "";
    const text = c.text.trim().split("\n").map((l) => `   ${l}`).join("\n");
    return `${i + 1}. \`${c.path}:${c.line}\`${quote}\n${text}`;
  });
  const n = comments.length;
  return `Review comments on your changes (${n} comment${n === 1 ? "" : "s"}). Please address each one:\n\n${parts.join("\n\n")}`;
}

export interface TreeDir<F> {
  /** Full folder path (key for collapsing). */
  path: string;
  /** Shown name; chains of single folders are merged ("src/server"). */
  name: string;
  dirs: TreeDir<F>[];
  files: F[];
}

/** Group files by folder: folders first, then files, both by name; single-child folder chains are merged. */
export function buildTree<F extends { path: string }>(files: F[]): TreeDir<F> {
  const root: TreeDir<F> = { path: "", name: "", dirs: [], files: [] };
  for (const f of files) {
    const segs = f.path.split("/");
    let dir = root;
    for (const seg of segs.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${seg}` : seg;
      let next = dir.dirs.find((d) => d.path === path);
      if (!next) {
        next = { path, name: seg, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  const tidy = (d: TreeDir<F>): TreeDir<F> => {
    let dirs = d.dirs.map(tidy);
    dirs = dirs.map((c) => {
      while (c.files.length === 0 && c.dirs.length === 1) {
        const only: TreeDir<F> = c.dirs[0];
        c = { ...only, name: `${c.name}/${only.name}` };
      }
      return c;
    });
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const files = d.files.slice().sort((a, b) => a.path.localeCompare(b.path));
    return { ...d, dirs, files };
  };
  return tidy(root);
}

/** Files in the order the tree shows them (used to pick the first file). */
export function treeOrder<F extends { path: string }>(d: TreeDir<F>): F[] {
  return [...d.dirs.flatMap(treeOrder), ...d.files];
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
