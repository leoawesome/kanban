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

export function buildArgs(prompt: string, sessionId: string, resume: boolean, model?: string | null): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
  args.push(resume ? "--resume" : "--session-id", sessionId);
  if (model) args.push("--model", model);
  return args;
}

export function startRun(opts: {
  bin: string;
  cwd: string;
  args: string[];
  onEvent: (ev: any) => void;
}): RunHandle {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const events: any[] = [];

  const done = (async (): Promise<RunOutput> => {
    try {
      proc = Bun.spawn([opts.bin, ...opts.args], {
        cwd: opts.cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
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
        events.push(ev);
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
      p.kill("SIGTERM");
      const timer = setTimeout(() => p.kill("SIGKILL"), 5000);
      p.exited.then(() => clearTimeout(timer));
    },
  };
}
