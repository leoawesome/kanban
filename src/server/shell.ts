import { existsSync } from "node:fs";

/** Bun ≥ 1.3.5 can spawn processes on a pseudo-terminal (`Bun.spawn({ terminal })`). */
export function ptySupported(): boolean {
  return typeof (Bun as any).Terminal === "function";
}

const MAX_SCROLLBACK = 200 * 1024;

export type ShellListener = (e: { type: "data"; data: Uint8Array } | { type: "exit"; code: number | null }) => void;

/** One interactive login shell on a PTY. Output is kept (bounded) so a reconnecting client can replay it. */
export class Shell {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private listeners = new Set<ShellListener>();
  private proc: ReturnType<typeof Bun.spawn>;
  exitCode: number | null | undefined = undefined;

  constructor(cwd: string, cols: number, rows: number, shell = process.env.SHELL || "/bin/zsh") {
    if (!existsSync(shell)) shell = "/bin/zsh";
    // Drop markers of a parent Claude session (daemon started from one) so `claude` runs normally in this shell.
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...env } = process.env;
    this.proc = Bun.spawn([shell, "-l"], {
      cwd,
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols, rows, name: "xterm-256color",
        data: (_t, data) => this.push(data),
      },
    });
    this.proc.exited.then((code) => {
      this.exitCode = code;
      for (const l of this.listeners) l({ type: "exit", code });
    });
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  /** Recent output, oldest first. */
  scrollback(): Uint8Array {
    const out = new Uint8Array(this.bytes);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  private push(data: Uint8Array) {
    const copy = data.slice();
    this.chunks.push(copy);
    this.bytes += copy.length;
    while (this.bytes > MAX_SCROLLBACK && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.length;
    for (const l of this.listeners) l({ type: "data", data: copy });
  }

  subscribe(l: ShellListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  write(data: string) {
    if (!this.exited) this.proc.terminal?.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.exited && cols > 0 && rows > 0) this.proc.terminal?.resize(cols, rows);
  }

  kill() {
    if (this.exited) return;
    try {
      this.proc.kill("SIGHUP");
    } catch {}
    this.proc.terminal?.close();
  }
}

/** One shell per profile, kept alive across page reloads until restarted, the profile is deleted or the daemon stops. */
export class ShellManager {
  private shells = new Map<string, Shell>();

  constructor(private spawn: (cwd: string, cols: number, rows: number) => Shell = (cwd, c, r) => new Shell(cwd, c, r)) {}

  /** The profile's shell, starting one if there is none (or the old one exited and `restart` is set). */
  get(slug: string, cwd: string, cols = 80, rows = 24, restart = false): Shell {
    let s = this.shells.get(slug);
    if (s && restart) {
      s.kill();
      s = undefined;
    }
    if (!s) {
      s = this.spawn(cwd, cols, rows);
      this.shells.set(slug, s);
    }
    return s;
  }

  current(slug: string): Shell | undefined {
    return this.shells.get(slug);
  }

  kill(slug: string) {
    this.shells.get(slug)?.kill();
    this.shells.delete(slug);
  }

  killAll() {
    for (const slug of [...this.shells.keys()]) this.kill(slug);
  }
}
