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
): string[] {
  // Prompts go in on stdin (see startRun) so more messages can follow while Claude works;
  // --replay-user-messages echoes each one back when Claude picks it up.
  // --include-partial-messages: token-level stream events, used for live replies in the chat.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--include-partial-messages", "--permission-mode", permissionMode];
  args.push(resume ? "--resume" : "--session-id", sessionId);
  if (model) args.push("--model", model);
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
}): RunHandle {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const events: any[] = [];
  let stdin: import("bun").FileSink | null = null;
  // Messages written but not yet picked up by Claude (no replay seen).
  let unread = 0;
  const closeInput = () => {
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
        // Claude is done and nothing is waiting: end input so the process exits. Messages still
        // unread keep it open; Claude answers them in another turn with its own result.
        if (ev?.type === "result" && unread === 0) closeInput();
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
