import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findSessionFile } from "./session";
import { shellQuote } from "./util";
import { IS_BINARY } from "./version";

/**
 * Headless `claude -p` runs never get the built-in Artifact tool (off by design in SDK contexts).
 * This helper publishes/reads artifacts through a short-lived interactive `claude` in a hidden tmux
 * session, which does have it, and reads the result from that session's transcript.
 */

export const TMUX_PREFIX = "ckanban-artifact-";

export type ArtifactJob =
  | { kind: "publish"; file: string; url?: string; title?: string }
  | { kind: "read"; url: string };

export type ArtifactOutcome =
  | { ok: true; kind: "publish"; url: string; text: string }
  | { ok: true; kind: "read"; html: string }
  | { ok: false; error: string };

/** How a board run calls this helper (the daemon may run from source, so `ckanban` isn't on PATH). */
export function helperCommand(): string {
  return helperArgv().map(shellQuote).join(" ");
}

export function helperArgv(): string[] {
  return IS_BINARY ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "cli.ts")];
}

/** Env for the helper: drop the markers a board run passes down, or the child counts as SDK and loses Artifact. */
export function helperEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "CLAUDE_CODE_ENTRYPOINT" || k === "CLAUDECODE") continue;
    out[k] = v;
  }
  out.CLAUDE_CODE_ARTIFACT_AUTO_OPEN = "0";
  return out;
}

function readPrompt(url: string): string {
  return `Call the Artifact tool once with action "read" and url ${url}. Do nothing else: no other tools, no summary. Then reply DONE.`;
}

/**
 * Messages the helper session gets, one per turn. Republishing needs two: the service refuses a
 * publish unless this session viewed the live version in an earlier turn. The caller already read
 * that version and merged its edits into the file, so the helper only views it to be allowed.
 */
export function jobPrompts(job: ArtifactJob): string[] {
  if (job.kind === "read") return [readPrompt(job.url)];
  const title = job.title ? ` Use the title ${JSON.stringify(job.title)}.` : "";
  const rules = "Publish the file exactly as it is on disk: it already contains the latest live content plus the new edits. Do not read, edit or rewrite it yourself and call no other tools. Then reply DONE.";
  if (!job.url) return [`Publish the file ${job.file} with the Artifact tool.${title} ${rules}`];
  return [
    readPrompt(job.url),
    `Now publish the file ${job.file} with the Artifact tool, passing url ${job.url}, so it becomes a new version at that same link.${title} ${rules}`,
  ];
}

/**
 * tmux argv. The command runs through `env -u` because the tmux server's global environment may
 * come from a board run too, so unsetting only our own spawn env isn't enough.
 */
export function tmuxArgs(o: { name: string; cwd: string; bin: string; sessionId: string; model: string; prompt: string }): string[] {
  return [
    "tmux", "new-session", "-d", "-s", o.name, "-x", "200", "-y", "50", "-c", o.cwd,
    "env", "-u", "CLAUDE_CODE_ENTRYPOINT", "-u", "CLAUDECODE", "CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0",
    o.bin, "--model", o.model, "--permission-mode", "bypassPermissions", "--session-id", o.sessionId, o.prompt,
  ];
}

const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

/** Page source from a read result: the tagged raw HTML, minus the document shell the viewer adds. */
export function extractReadHtml(text: string): string | null {
  const m = text.match(/<cowritten-artifact-html>\n([\s\S]*?)\n<\/cowritten-artifact-html>/);
  if (!m) return null;
  let html = m[1];
  const shell = html.match(/^<!doctype html><html><head>[\s\S]*?<\/head><body>\n/i);
  if (shell && /<\/body><\/html>\s*$/i.test(html)) html = html.slice(shell[0].length).replace(/\n?<\/body><\/html>\s*$/i, "");
  return html;
}

/** The helper session's answer to the job, or null while it is still working. */
export function findOutcome(raw: string, kind: ArtifactJob["kind"]): ArtifactOutcome | null {
  const uses = new Map<string, any>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b.name === "Artifact") uses.set(b.id, b.input ?? {});
      if (b?.type !== "tool_result") continue;
      const text = resultText(b.content);
      if (/No such tool available: Artifact|Artifact exists but is not enabled/.test(text)) {
        return { ok: false, error: `Artifact tool is not available in the helper session: ${text.replace(/<\/?tool_use_error>/g, "").trim()}` };
      }
      const input = uses.get(b.tool_use_id);
      if (!input) continue;
      const action = typeof input.action === "string" ? input.action : "publish";
      if (kind === "read" ? action !== "read" : !(action === "publish" || input.file_path)) continue;
      if (b.is_error || text.includes("<tool_use_error>")) {
        return { ok: false, error: text.replace(/<\/?tool_use_error>/g, "").trim() };
      }
      if (kind === "read") {
        const html = extractReadHtml(text);
        return html === null ? { ok: false, error: "read result had no page source" } : { ok: true, kind: "read", html };
      }
      const m = text.match(PUBLISHED);
      const url = m?.[2] ?? (typeof ev.toolUseResult?.url === "string" ? ev.toolUseResult.url : null);
      return url ? { ok: true, kind: "publish", url, text: m?.[0] ?? `Published ${input.file_path} at ${url}` } : { ok: false, error: text.trim() };
    }
  }
  return null;
}

/** Interactive prompts the helper may hit before its prompt runs. */
export function paneState(pane: string): "trust" | "bypass" | null {
  if (/Yes, I trust this folder/.test(pane)) return "trust";
  if (/Bypass Permissions mode/i.test(pane) && /Yes, I accept/.test(pane)) return "bypass";
  return null;
}

export interface RunOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  /** Folder the helper runs in; ckanban owns it, so accepting Claude's trust prompt there is safe. */
  cwd?: string;
  pollMs?: number;
}

async function tmux(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
}

export async function runArtifactJob(job: ArtifactJob, o: RunOptions = {}): Promise<ArtifactOutcome> {
  if (!Bun.which("tmux")) return { ok: false, error: "tmux is required for artifact publishing. Install it with: brew install tmux" };
  const cwd = o.cwd ?? join(homedir(), ".claude-kanban", "artifact-helper");
  mkdirSync(cwd, { recursive: true });
  const sessionId = crypto.randomUUID();
  const name = `${TMUX_PREFIX}${sessionId.slice(0, 8)}`;
  const timeoutMs = o.timeoutMs ?? 180_000;
  const pollMs = o.pollMs ?? 1000;

  const kill = () => {
    Bun.spawnSync(["tmux", "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
  };
  const onSignal = () => {
    kill();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const prompts = jobPrompts(job);
    // Each step's outcome is what that turn's tool call returned; only the last one is the job's.
    const steps: ArtifactJob["kind"][] = prompts.map((_, i) => (i < prompts.length - 1 ? "read" : job.kind));
    let step = 0;
    const [cmd, ...args] = tmuxArgs({ name, cwd, bin: o.bin ?? "claude", sessionId, model: o.model ?? "haiku", prompt: prompts[0] });
    const p = Bun.spawn([cmd, ...args], { env: helperEnv(process.env), stdout: "ignore", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    if ((await p.exited) !== 0) return { ok: false, error: `could not start tmux: ${err.trim()}` };

    const deadline = Date.now() + timeoutMs;
    let trusted = false;
    while (Date.now() < deadline) {
      await Bun.sleep(pollMs);
      const file = findSessionFile(sessionId);
      if (file) {
        const outcome = findOutcome(readFileSync(file, "utf8"), steps[step]);
        if (outcome && (!outcome.ok || step === prompts.length - 1)) return outcome;
        if (outcome) {
          step++;
          await tmux(["send-keys", "-t", name, "-l", prompts[step]]);
          await Bun.sleep(300);
          await tmux(["send-keys", "-t", name, "Enter"]);
        }
      }
      const pane = await tmux(["capture-pane", "-p", "-t", name]);
      if (pane.code !== 0) return { ok: false, error: "helper Claude session exited before the artifact was done (is Claude Code logged in with /login?)" };
      const state = paneState(pane.out);
      if (state === "trust" && !trusted) {
        trusted = true;
        await tmux(["send-keys", "-t", name, "Down"]);
        await Bun.sleep(200);
        await tmux(["send-keys", "-t", name, "Enter"]);
      } else if (state === "bypass") {
        return { ok: false, error: "Claude Code asks to confirm bypass-permissions mode. Run `claude --permission-mode bypassPermissions` once in a terminal and accept, then retry." };
      }
    }
    return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the helper Claude session` };
  } finally {
    kill();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
