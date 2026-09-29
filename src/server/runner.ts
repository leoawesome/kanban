export interface RunOutput {
  code: number;
  stderr: string;
  events: any[];
}

export interface RunHandle {
  done: Promise<RunOutput>;
  stop(): void;
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
  prompt: string, sessionId: string, resume: boolean, model?: string | null,
  permissionMode: "bypassPermissions" | "plan" = "bypassPermissions",
): string[] {
  // --include-partial-messages: token-level stream events, used for live replies in the chat.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", permissionMode];
  args.push(resume ? "--resume" : "--session-id", sessionId);
  if (model) args.push("--model", model);
  return args;
}

export function startRun(opts: {
  bin: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  onEvent: (ev: any) => void;
}): RunHandle {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const events: any[] = [];

  const done = (async (): Promise<RunOutput> => {
    try {
      proc = Bun.spawn([opts.bin, ...opts.args], {
        cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
        // Own process group so stop() can take down tools claude spawned (shells, dev servers).
        detached: true,
      });
    } catch (e) {
      return { code: -1, stderr: `failed to start ${opts.bin}: ${(e as Error).message}`, events };
    }
    const p = proc;

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
    return { code, stderr: stderr.slice(-STDERR_TAIL), events };
  })();

  return {
    done,
    get stopped() {
      return stopped;
    },
    stop() {
      if (!proc || stopped) return;
      stopped = true;
      const p = proc;
      killGroup(p.pid, "TERM");
      const timer = setTimeout(() => killGroup(p.pid, "KILL"), 5000);
      p.exited.then(() => clearTimeout(timer));
    },
  };
}
