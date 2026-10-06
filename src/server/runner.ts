import type { BackgroundTask } from "./types";

export interface RunOutput {
  code: number;
  stderr: string;
  events: any[];
}

export interface RunHandle {
  done: Promise<RunOutput>;
  stop(): void;
  /**
   * Hand Claude another user message while it works; it reads it at its next step, like typing
   * in an interactive session. False once input is closed (the run is finishing).
   */
  send(text: string): boolean;
  readonly stopped: boolean;
}

/** After Claude's last task finishes, how long to wait for the turn it starts before ending input anyway. */
export const BACKGROUND_GRACE_MS = 10_000;
const TASK_DONE = new Set(["completed", "failed", "killed", "stopped"]);

const STDERR_TAIL = 2048;

function killGroup(pid: number, signal: "TERM" | "KILL") {
  const r = Bun.spawnSync(["kill", `-${signal}`, "--", `-${pid}`], { stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) {
    try {
      process.kill(pid, `SIG${signal}`);
    } catch {}
  }
}

export function buildArgs(
  sessionId: string, resume: boolean, model?: string | null,
  permissionMode: "bypassPermissions" | "plan" = "bypassPermissions",
  /** Inline MCP config (see mcpConfig) so every run has the board's tools. */
  mcp?: string,
): string[] {
  // Prompts go in on stdin (see startRun) so more messages can follow while Claude works;
  // --replay-user-messages echoes each one back when Claude picks it up.
  // --include-partial-messages: token-level stream events, used for live replies in the chat.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--include-partial-messages", "--permission-mode", permissionMode];
  args.push(resume ? "--resume" : "--session-id", sessionId);
  if (model) args.push("--model", model);
  if (mcp) args.push("--mcp-config", mcp);
  return args;
}

function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

export function startRun(opts: {
  bin: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  /** First user message, written to stdin (needs --input-format stream-json in args). */
  input?: string;
  onEvent: (ev: any) => void;
  /**
   * Claude ended its turn but background tasks it waits on are still running (the run stays
   * open so it can pick their results up); null once it is working or done again.
   */
  onWaiting?: (tasks: BackgroundTask[] | null) => void;
  graceMs?: number;
}): RunHandle {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const events: any[] = [];
  let stdin: import("bun").FileSink | null = null;
  // Messages written but not yet picked up by Claude (no replay seen).
  let unread = 0;
  // Background tasks still running. Claude Code kills them when input ends, and starts a turn of
  // its own when one finishes, so input stays open while any are left.
  const tasks = new Map<string, BackgroundTask>();
  // Between Claude's result and its next turn.
  let idle = false;
  let waiting = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const clearGrace = () => {
    if (grace) clearTimeout(grace);
    grace = null;
  };
  const report = () => {
    const now = idle && tasks.size > 0 && !!stdin;
    if (!now && !waiting) return;
    waiting = now;
    opts.onWaiting?.(now ? [...tasks.values()] : null);
  };
  const closeInput = () => {
    clearGrace();
    const s = stdin;
    stdin = null;
    try {
      s?.end();
    } catch {}
  };
  const write = (text: string): boolean => {
    if (!stdin) return false;
    try {
      stdin.write(userMessage(text));
      stdin.flush();
    } catch {
      stdin = null;
      return false;
    }
    unread++;
    return true;
  };

  const done = (async (): Promise<RunOutput> => {
    try {
      proc = Bun.spawn([opts.bin, ...opts.args], {
        cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: opts.input === undefined ? "ignore" : "pipe",
        // Own process group so stop() can take down tools claude spawned (shells, dev servers).
        detached: true,
      });
    } catch (e) {
      return { code: -1, stderr: `failed to start ${opts.bin}: ${(e as Error).message}`, events };
    }
    const p = proc;
    if (opts.input !== undefined) {
      stdin = p.stdin as import("bun").FileSink;
      write(opts.input);
    }

    const trackTasks = (ev: any) => {
      if (ev?.type !== "system") return;
      if (ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
        // The full current list: keep first-seen times for tasks already known.
        const known = new Map(tasks);
        tasks.clear();
        for (const t of ev.tasks) {
          const id = String(t?.task_id ?? "");
          if (!id) continue;
          tasks.set(id, known.get(id) ?? { id, description: String(t.description || "Background task"), startedAt: new Date().toISOString() });
        }
      } else if (ev.subtype === "task_notification" && TASK_DONE.has(ev.status)) tasks.delete(String(ev.task_id));
      else if (ev.subtype === "task_updated" && TASK_DONE.has(ev.patch?.status)) tasks.delete(String(ev.task_id));
    };

    const readStdout = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        // Partial-message deltas are only for the live view; don't keep thousands of them in memory.
        if (ev?.type !== "stream_event") events.push(ev);
        if (ev?.type === "user" && ev.isReplay) unread = Math.max(0, unread - 1);
        trackTasks(ev);
        if (ev?.type === "result") idle = true;
        else if (ev?.type === "assistant" || ev?.type === "stream_event" || (ev?.type === "system" && ev.subtype === "init")) {
          idle = false;
          clearGrace();
        }
        // Claude is done and nothing is waiting: end input so the process exits. Messages still
        // unread keep it open; Claude answers them in another turn with its own result. So do
        // background tasks: Claude resumes on its own when they finish.
        if (idle && unread === 0 && stdin) {
          if (!tasks.size && ev?.type === "result") closeInput();
          // The last task finished after the result: Claude normally starts a turn for it at
          // once; if it doesn't, don't keep the process around forever.
          else if (!tasks.size && !grace) grace = setTimeout(() => {
            grace = null;
            if (idle && unread === 0 && !tasks.size) closeInput();
          }, opts.graceMs ?? BACKGROUND_GRACE_MS);
        }
        report();
        opts.onEvent(ev);
      };
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handleLine(buf);
    })();

    const stderrText = new Response(p.stderr as ReadableStream).text();
    const [code, stderr] = await Promise.all([p.exited, stderrText, readStdout]);
    closeInput();
    idle = false;
    report();
    return { code, stderr: stderr.slice(-STDERR_TAIL), events };
  })();

  return {
    done,
    send: (text) => !stopped && write(text),
    get stopped() {
      return stopped;
    },
    stop() {
      if (!proc || stopped) return;
      stopped = true;
      closeInput();
      const p = proc;
      killGroup(p.pid, "TERM");
      const timer = setTimeout(() => killGroup(p.pid, "KILL"), 5000);
      p.exited.then(() => clearTimeout(timer));
    },
  };
}
