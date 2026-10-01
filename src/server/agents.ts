import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { helperArgv } from "./artifact";
import { which } from "./git";
import { newId } from "./util";

/**
 * Registers `ckanban mcp` with outside agents (Claude Code, Codex) so they can use the board.
 * Claude Code goes through `claude mcp add --scope user`; Codex through ~/.codex/config.toml.
 */

export type AgentId = "claude" | "codex";
export const AGENT_IDS: AgentId[] = ["claude", "codex"];
export const SERVER_NAME = "ckanban";

export interface AgentStatus {
  id: AgentId;
  label: string;
  /** The agent's CLI is on PATH. */
  available: boolean;
  /** A `ckanban` MCP entry exists. */
  installed: boolean;
  /** It runs this ckanban (an entry from an old install path counts as installed but not current). */
  current: boolean;
  /** Registered command line, if any. */
  command: string | null;
  configPath: string;
}

export class AgentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface AgentOptions {
  claudeBin?: string;
  codexBin?: string;
  /** Claude's global config. Default: $CLAUDE_CONFIG_DIR/.claude.json or ~/.claude.json. */
  claudeConfig?: string;
  /** Default: $CODEX_HOME/config.toml or ~/.codex/config.toml. */
  codexConfig?: string;
  /** Command the agents should run. Default: this ckanban + `mcp`. */
  serverArgv?: string[];
}

function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, content);
  // Keep the original permissions (config.toml may hold tokens).
  if (existsSync(file)) chmodSync(tmp, statSync(file).mode & 0o777);
  renameSync(tmp, file);
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const sameArgv = (a: string[] | null, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const display = (argv: string[] | null) => (argv ? argv.join(" ") : null);

// --- Codex config.toml ------------------------------------------------------------------------

const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;

function tableKey(header: string): string[] {
  return header.split(".").map((k) => k.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}

function isOurTable(header: string): boolean {
  const k = tableKey(header);
  return k[0] === "mcp_servers" && k[1] === SERVER_NAME;
}

/** Drops `[mcp_servers.ckanban]` (and its sub-tables) from a config.toml, keeping everything else. */
export function removeCodexServer(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const h = line.match(HEADER);
    if (h) skipping = isOurTable(h[1]);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Adds or replaces `[mcp_servers.ckanban]` in a config.toml. */
export function setCodexServer(toml: string, argv: string[]): string {
  const [command, ...args] = argv;
  // JSON strings are valid TOML basic strings.
  const block = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args).replace(/","/g, '", "')}\n`;
  const rest = removeCodexServer(toml).replace(/\s+$/, "");
  return rest ? `${rest}\n\n${block}` : block;
}

/** argv of the registered `[mcp_servers.ckanban]`, or null. */
export function readCodexServer(toml: string): string[] | null {
  let inside = false;
  let command: string | null = null;
  let args: string[] = [];
  for (const line of toml.split("\n")) {
    const h = line.match(HEADER);
    if (h) {
      const k = tableKey(h[1]);
      inside = k.length === 2 && isOurTable(h[1]);
      continue;
    }
    if (!inside) continue;
    const m = line.match(/^\s*(command|args)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    try {
      const v = JSON.parse(m[2].replace(/^'(.*)'$/, (_, s) => JSON.stringify(s)));
      if (m[1] === "command" && typeof v === "string") command = v;
      if (m[1] === "args" && Array.isArray(v)) args = v.map(String);
    } catch {}
  }
  return command ? [command, ...args] : null;
}

// --- Manager ----------------------------------------------------------------------------------

export class AgentRegistry {
  private claudeBin: string;
  private codexBin: string;
  private claudeConfig: string;
  private codexConfig: string;
  readonly serverArgv: string[];

  constructor(opts: AgentOptions = {}) {
    this.claudeBin = opts.claudeBin ?? process.env.CKANBAN_CLAUDE_BIN ?? "claude";
    this.codexBin = opts.codexBin ?? "codex";
    this.claudeConfig = opts.claudeConfig ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
    this.codexConfig = opts.codexConfig ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
    this.serverArgv = opts.serverArgv ?? [...helperArgv(), "mcp"];
  }

  private claudeEntry(): string[] | null {
    const e = readJson(this.claudeConfig)?.mcpServers?.[SERVER_NAME];
    if (!e || typeof e.command !== "string") return null;
    return [e.command, ...(Array.isArray(e.args) ? e.args.map(String) : [])];
  }

  private codexEntry(): string[] | null {
    return readCodexServer(readText(this.codexConfig));
  }

  async status(): Promise<AgentStatus[]> {
    const [claudeAt, codexAt] = await Promise.all([which(this.claudeBin), which(this.codexBin)]);
    const claude = this.claudeEntry();
    const codex = this.codexEntry();
    return [
      {
        id: "claude", label: "Claude Code", available: !!claudeAt, installed: !!claude,
        current: sameArgv(claude, this.serverArgv), command: display(claude), configPath: this.claudeConfig,
      },
      {
        id: "codex", label: "Codex", available: !!codexAt || existsSync(dirname(this.codexConfig)), installed: !!codex,
        current: sameArgv(codex, this.serverArgv), command: display(codex), configPath: this.codexConfig,
      },
    ];
  }

  /** Registers (or re-points) the ckanban MCP. No-op when it's already current. */
  async install(id: AgentId): Promise<void> {
    if (id === "claude") {
      if (sameArgv(this.claudeEntry(), this.serverArgv)) return;
      if (this.claudeEntry()) await this.claude(["mcp", "remove", SERVER_NAME, "--scope", "user"]);
      await this.claude(["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...this.serverArgv]);
      return;
    }
    if (id === "codex") {
      const text = readText(this.codexConfig);
      if (sameArgv(readCodexServer(text), this.serverArgv)) return;
      atomicWrite(this.codexConfig, setCodexServer(text, this.serverArgv));
      return;
    }
    throw new AgentError(400, `unknown agent ${id}`);
  }

  async uninstall(id: AgentId): Promise<void> {
    if (id === "claude") {
      if (this.claudeEntry()) await this.claude(["mcp", "remove", SERVER_NAME, "--scope", "user"]);
      return;
    }
    if (id === "codex") {
      const text = readText(this.codexConfig);
      if (readCodexServer(text)) atomicWrite(this.codexConfig, removeCodexServer(text).replace(/\s+$/, "") + "\n");
      return;
    }
    throw new AgentError(400, `unknown agent ${id}`);
  }

  private async claude(args: string[]): Promise<void> {
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn([this.claudeBin, ...args], { cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      throw new AgentError(502, `Claude CLI not found (${this.claudeBin}). Is Claude Code installed and on PATH?`);
    }
    const timer = setTimeout(() => p.kill(), 60_000);
    const [code, out, err] = await Promise.all([
      p.exited, new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(),
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new AgentError(502, `claude ${args.slice(0, 2).join(" ")} failed: ${(err.trim() || out.trim() || `exit code ${code}`).split("\n").slice(-3).join("\n")}`);
  }
}
