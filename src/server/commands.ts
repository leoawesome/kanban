import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/**
 * Slash commands a ticket chat can run, like typing `/name` in Claude Code: skills, custom commands
 * and a few built-ins. The board lists them for the composer's `/` picker and decides how to send a
 * message that starts with one (see slashMessage).
 */
export type CommandKind = "skill" | "command" | "builtin";
/** claude: bundled with Claude Code (only known from a run's init event); board: the board runs it itself. */
export type CommandSource = "user" | "project" | "plugin" | "claude" | "board";

export interface SlashCommand {
  name: string;
  kind: CommandKind;
  source: CommandSource;
  description: string;
  /** Runs inside Claude Code without a model turn (no replay of the message, no reply from Claude). */
  local?: boolean;
}

/**
 * Built-ins offered in the picker. compact/context run natively in `claude -p`. clear and model are
 * handled by the board: Claude Code's own /clear starts a session the board doesn't know about, and its
 * /model only lasts for one process, while every board message is a new one.
 */
export const BUILTINS: SlashCommand[] = [
  { name: "compact", kind: "builtin", source: "claude", local: true, description: "Summarise the conversation to free up context" },
  { name: "context", kind: "builtin", source: "claude", local: true, description: "Show how much context the conversation uses" },
  { name: "clear", kind: "builtin", source: "board", description: "Start a fresh Claude session for this ticket" },
  { name: "model", kind: "builtin", source: "board", description: "Switch the model for this ticket's next runs (e.g. /model sonnet)" },
];

export const BOARD_COMMANDS = new Set(BUILTINS.filter((c) => c.source === "board").map((c) => c.name));

interface Dirs {
  configDir?: string;
}

function configDirOf(d: Dirs): string {
  return d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `description` (and `name`) from a markdown file's YAML frontmatter; the first text line when there is none. */
export function frontmatter(text: string): { name?: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const out: { name?: string; description: string } = { description: "" };
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let v = kv[2].trim();
      // Folded/literal block (description: > or |): the indented lines that follow.
      if (/^[>|][-+]?$/.test(v)) {
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
        v = block.join(" ");
      }
      v = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
      if (kv[1] === "name") out.name = v;
      else out.description = v;
    }
  }
  if (!out.description) {
    const body = m ? text.slice(m[0].length) : text;
    out.description = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  }
  out.description = out.description.replace(/\s+/g, " ").trim();
  return out;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `<dir>/<name>/SKILL.md` skills. */
function scanSkills(dir: string, source: CommandSource, prefix = ""): SlashCommand[] {
  if (!isDir(dir)) return [];
  const out: SlashCommand[] = [];
  for (const d of readdirSync(dir).sort()) {
    const text = readText(join(dir, d, "SKILL.md"));
    if (text === null) continue;
    const fm = frontmatter(text);
    out.push({ name: prefix + (fm.name || d), kind: "skill", source, description: fm.description });
  }
  return out;
}

/** `<dir>/**\/*.md` custom commands; subfolders become `folder:name`, as in Claude Code. */
function scanCommands(dir: string, source: CommandSource, prefix = ""): SlashCommand[] {
  if (!isDir(dir)) return [];
  const out: SlashCommand[] = [];
  const walk = (d: string, depth: number) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (isDir(p)) {
        if (depth < 3) walk(p, depth + 1);
        continue;
      }
      if (!f.endsWith(".md")) continue;
      const text = readText(p);
      if (text === null) continue;
      const name = relative(dir, p).slice(0, -3).split(/[\\/]/).join(":");
      out.push({ name: prefix + name, kind: "command", source, description: frontmatter(text).description });
    }
  };
  walk(dir, 0);
  return out;
}

/** Install folders of the enabled plugins that apply to `projects` (user-wide or installed for one of them). */
function pluginDirs(configDir: string, projects: string[]): { name: string; dir: string }[] {
  const enabled: Record<string, unknown> = { ...readJson(join(configDir, "settings.json"))?.enabledPlugins };
  for (const p of projects) {
    for (const f of ["settings.json", "settings.local.json"]) Object.assign(enabled, readJson(join(p, ".claude", f))?.enabledPlugins);
  }
  const installed = readJson(join(configDir, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const out: { name: string; dir: string }[] = [];
  for (const [key, entries] of Object.entries<any>(installed)) {
    if (enabled[key] !== true || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e?.scope === "user") ?? entries.find((e) => typeof e?.projectPath === "string" && projects.includes(e.projectPath));
    if (!entry || typeof entry.installPath !== "string") continue;
    const name = readJson(join(entry.installPath, ".claude-plugin", "plugin.json"))?.name ?? key.split("@")[0];
    out.push({ name: String(name), dir: entry.installPath });
  }
  return out;
}

/** What the latest run in a folder said it has (stream-json system/init): the truth for that session. */
interface InitInfo {
  skills: string[];
  slashCommands: string[];
}
const inits = new Map<string, InitInfo>();

/** Remember a run's init event (keyed by its cwd) so the list matches what Claude really has. */
export function rememberInit(cwd: string, ev: any): void {
  if (ev?.type !== "system" || ev.subtype !== "init") return;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  inits.set(cwd, { skills: strings(ev.skills), slashCommands: strings(ev.slash_commands) });
  cache.delete(cwd);
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; list: SlashCommand[] }>();

/**
 * Everything `/` can run in `cwd`: built-ins, then project, user and plugin skills and commands
 * (project wins over user on the same name), plus skills only a run's init event knew (bundled ones).
 * projects: folders whose project settings and plugins apply (the worktree and the board's main checkout).
 */
export function listCommands(cwd: string, opts: Dirs & { projects?: string[]; fresh?: boolean } = {}): SlashCommand[] {
  const hit = cache.get(cwd);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const configDir = configDirOf(opts);
  const projects = [...new Set([cwd, ...(opts.projects ?? [])])];
  const byName = new Map<string, SlashCommand>();
  const add = (list: SlashCommand[]) => {
    for (const c of list) if (c.name && !byName.has(c.name)) byName.set(c.name, c);
  };
  add(BUILTINS);
  add(scanSkills(join(cwd, ".claude", "skills"), "project"));
  add(scanCommands(join(cwd, ".claude", "commands"), "project"));
  add(scanSkills(join(configDir, "skills"), "user"));
  add(scanCommands(join(configDir, "commands"), "user"));
  for (const p of pluginDirs(configDir, projects)) {
    add(scanSkills(join(p.dir, "skills"), "plugin", `${p.name}:`));
    add(scanCommands(join(p.dir, "commands"), "plugin", `${p.name}:`));
  }
  const init = inits.get(cwd);
  if (init) add(init.skills.map((name) => ({ name, kind: "skill", source: "claude", description: "" })));
  const list = [...byName.values()];
  cache.set(cwd, { at: Date.now(), list });
  return list;
}

/** `/name rest` at the start of a message: name and the arguments after it. Paths like `/Users/x` don't count. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][\w.:-]*)(?=\s|$)([\s\S]*)$/.exec(text.trim());
  return m ? { name: m[1], args: m[2].trim() } : null;
}

/** The command a chat message runs, or null when it is plain text (unknown `/word` included). */
export function slashMessage(text: string, commands: SlashCommand[]): { command: SlashCommand; args: string; text: string } | null {
  const p = parseSlash(text);
  if (!p) return null;
  const command = commands.find((c) => c.name === p.name);
  return command ? { command, args: p.args, text: p.args ? `/${p.name} ${p.args}` : `/${p.name}` } : null;
}

/**
 * Claude Code stores (and replays) a slash command as tags:
 * `<command-message>x</command-message><command-name>/x</command-name><command-args>a b</command-args>`.
 * Returns `/x a b`, or null for any other text.
 */
export function commandText(text: string): string | null {
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (!name || !text.trimStart().startsWith("<command-")) return null;
  const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "").trim();
  return args ? `/${name} ${args}` : `/${name}`;
}

/** Output of a local command (/compact, /context) as Claude Code stores it, without the tags and colour codes. */
export function localCommandOutput(text: string): string | null {
  const m = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/.exec(text);
  return m ? m[2].replace(/\x1b\[[0-9;]*m/g, "").trim() : null;
}
