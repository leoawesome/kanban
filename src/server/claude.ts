import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "./git";

export interface ClaudeProject {
  path: string;
  name: string;
  lastUsed: string | null;
}

interface Dirs {
  homeDir?: string;
  configDir?: string;
  /** Paths under these prefixes are skipped (scratch/temp sessions). */
  excludePrefixes?: string[];
}

function configDirOf(d: Dirs): string {
  return d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(d.homeDir ?? homedir(), ".claude");
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Claude Code stores sessions under ~/.claude/projects/<cwd with every non-alphanumeric char as "-">. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

const TEMP_PREFIXES = ["/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/", tmpdir() + "/"];

/** Folders the user has run Claude Code in, most recent session first. */
export function listClaudeProjects(d: Dirs = {}): ClaudeProject[] {
  const home = d.homeDir ?? homedir();
  const configDir = configDirOf(d);
  // ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when Claude Code is configured that way.
  const stateDir = !d.homeDir && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : home;
  const state = readJson(join(stateDir, ".claude.json"));
  const exclude = d.excludePrefixes ?? TEMP_PREFIXES;
  const paths = Object.keys(state?.projects ?? {});
  const out: ClaudeProject[] = [];
  for (const path of paths) {
    if (exclude.some((p) => path.startsWith(p))) continue;
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const sessions = join(configDir, "projects", encodeProjectDir(path));
    let lastUsed: string | null = null;
    try {
      lastUsed = statSync(sessions).mtime.toISOString();
    } catch {}
    out.push({ path, name: basename(path), lastUsed });
  }
  return out.sort((a, b) => {
    if (a.lastUsed && b.lastUsed) return b.lastUsed.localeCompare(a.lastUsed);
    if (a.lastUsed) return -1;
    if (b.lastUsed) return 1;
    return a.path.localeCompare(b.path);
  });
}

/** User-level Claude Code defaults (runs without --model inherit these automatically). */
export function claudeDefaults(d: Dirs = {}): { model: string | null } {
  const settings = readJson(join(configDirOf(d), "settings.json"));
  return { model: typeof settings?.model === "string" && settings.model ? settings.model : null };
}

/** Native macOS folder chooser. Returns null when cancelled or unsupported. */
export async function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const script = `tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt "Choose a folder for this board")`;
  const r = await run(["osascript", "-e", script], homedir());
  if (r.code !== 0) return null;
  const path = r.stdout.trim().replace(/\/+$/, "");
  return path && existsSync(path) ? path : null;
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  lastActive: string;
}

function promptText(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join(" ") : "";
  const t = text.trim();
  // Skip slash-command / hook wrappers Claude Code stores as user messages.
  if (!t || t.startsWith("<") || /^(Base directory for this skill|Caveat:|\[Request interrupted)/.test(t)) return null;
  return t.replace(/\s+/g, " ").slice(0, 160);
}

/** Claude Code sessions started in `projectPath`, most recently active first. */
export function listSessions(projectPath: string, d: Dirs = {}, limit = 50): ClaudeSession[] {
  const dir = join(configDirOf(d), "projects", encodeProjectDir(projectPath));
  let files: { id: string; file: string; mtime: Date }[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.slice(0, -6), file: join(dir, f), mtime: statSync(join(dir, f)).mtime }));
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files.slice(0, limit).map(({ id, file, mtime }) => {
    let title: string | null = null;
    let firstPrompt: string | null = null;
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch {}
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const isTitle = line.includes('"custom-title"');
      if (!isTitle && (firstPrompt || !line.includes('"user"'))) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "custom-title" && typeof ev.customTitle === "string") title = ev.customTitle;
      else if (!firstPrompt && ev.type === "user" && ev.message?.role === "user") firstPrompt = promptText(ev.message.content);
    }
    return { id, title, firstPrompt, lastActive: mtime.toISOString() };
  });
}

/** True if any process command line looks like a claude CLI resuming this session (by id or title). */
export function liveSessionMatch(commands: string[], s: { id: string; title: string | null }): boolean {
  return commands.some((cmd) => {
    if (!/(^|[\s/])claude(\s|$)|claude(-code)?\/cli\.js/.test(cmd)) return false;
    if (cmd.includes(s.id)) return true;
    return !!s.title && cmd.includes(s.title);
  });
}

export async function processCommands(): Promise<string[]> {
  const r = await run(["ps", "-axo", "args="], homedir());
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export async function isSessionLive(id: string, title: string | null): Promise<boolean> {
  return liveSessionMatch(await processCommands(), { id, title });
}

export function sessionTitle(projectPath: string, id: string, d: Dirs = {}): string | null {
  return listSessions(projectPath, d, 500).find((s) => s.id === id)?.title ?? null;
}
