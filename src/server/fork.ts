import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeProjectDir } from "./claude";
import { atomicWrite } from "./store";

export interface ForkOptions {
  fromId: string;
  toId: string;
  /** Folder the source session ran in, and the folder the copy will run in. */
  fromCwd: string;
  toCwd: string;
  /** Attachment file names to swap (the branch gets its own copies of pasted images). */
  rename?: Record<string, string>;
}

/**
 * A session transcript rewritten for another session id and folder, like `claude --fork-session` would write it:
 * every line's sessionId becomes the new id and cwd moves to the new folder. Unparsable lines are kept as-is.
 */
export function rewriteSession(raw: string, o: ForkOptions): string {
  let text = raw;
  for (const [from, to] of Object.entries(o.rename ?? {})) text = text.split(from).join(to);
  return text.split("\n").map((line) => {
    if (!line.trim()) return line;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return line;
    }
    if (!ev || typeof ev !== "object") return line;
    if (ev.sessionId === o.fromId) ev.sessionId = o.toId;
    if (typeof ev.cwd === "string" && o.fromCwd !== o.toCwd) {
      if (ev.cwd === o.fromCwd) ev.cwd = o.toCwd;
      else if (ev.cwd.startsWith(`${o.fromCwd}/`)) ev.cwd = o.toCwd + ev.cwd.slice(o.fromCwd.length);
    }
    return JSON.stringify(ev);
  }).join("\n");
}

/** Claude Code keys sessions by the real folder path (e.g. /private/tmp, not /tmp). */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Copy a Claude session into the project folder of `toCwd` under a new id, so `claude --resume <toId>` run
 * there continues the conversation. Also copies the session's side folder (subagent transcripts, saved tool
 * output) when there is one. Returns the new transcript file.
 */
export function forkSessionFile(srcFile: string, o: ForkOptions, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string {
  const toCwd = real(o.toCwd);
  const dest = join(configDir, "projects", encodeProjectDir(toCwd), `${o.toId}.jsonl`);
  if (existsSync(dest)) throw new Error(`a Claude session ${o.toId} already exists`);
  const raw = readFileSync(srcFile, "utf8");
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, rewriteSession(raw, { ...o, fromCwd: real(o.fromCwd), toCwd }));
  const side = join(dirname(srcFile), o.fromId);
  if (existsSync(side)) {
    try {
      cpSync(side, join(dirname(dest), o.toId), { recursive: true });
    } catch {}
  }
  return dest;
}
