import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { shellSocketUrl, type PtyKind } from "./api";

function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--surface"),
    foreground: v("--text"),
    cursor: v("--accent"),
    cursorAccent: v("--surface"),
    selectionBackground: v("--accent-soft"),
    selectionForeground: v("--text"),
  };
}

/** The quick Claude chat is always dark (the page's dark-mode colours): Claude Code's colours assume a dark terminal. */
const DARK_THEME: ITheme = {
  background: "#242320",
  foreground: "#ecebe6",
  cursor: "#e0805e",
  cursorAccent: "#242320",
  selectionBackground: "#3d2a22",
  selectionForeground: "#ecebe6",
};

const themeFor = (kind: PtyKind) => (kind === "claude" ? DARK_THEME : themeFromCss());

type State = "connecting" | "open" | "exited" | "closed";

/**
 * xterm.js wired to the profile's shell (or quick Claude chat) over a WebSocket.
 * Binary frames are output; JSON text frames are control.
 */
export function TerminalView({ slug, kind = "shell", active, restartSignal, command, onCommandSent }: {
  slug: string;
  kind?: PtyKind;
  active: boolean;
  restartSignal: number;
  command: { text: string; n: number } | null;
  /** Called once the command was typed into the shell, so it isn't replayed on remount. */
  onCommandSent?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Auto-reconnect with backoff (1s, 2s, 4s… up to 30s) after the socket drops.
  const retries = useRef(0);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  // Command waiting for the shell to be connected (sent once, then cleared).
  const pendingCommand = useRef<{ text: string; n: number } | null>(null);
  const sentCommand = useRef<number | null>(null);

  const send = (msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };

  // One xterm instance for the component's lifetime.
  useEffect(() => {
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: themeFor(kind),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try {
      f.fit();
    } catch {}

    const onData = t.onData((data) => {
      // An ended quick chat waits for the "Start again" button instead of any key.
      if (stateRef.current === "exited") {
        if (kind === "shell") send({ type: "restart" });
      } else send({ type: "input", data });
    });
    const onResize = t.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) {
        try {
          f.fit();
        } catch {}
      }
    });
    ro.observe(host.current!);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => (t.options.theme = themeFor(kind));
    dark.addEventListener("change", onScheme);
    return () => {
      onData.dispose();
      onResize.dispose();
      ro.disconnect();
      dark.removeEventListener("change", onScheme);
      t.dispose();
    };
  }, []);

  // (Re)connect. The server replays recent output, so start from a clean screen.
  useEffect(() => {
    const t = term.current!;
    t.reset();
    setState("connecting");
    const sock = new WebSocket(shellSocketUrl(slug, t.cols, t.rows, kind));
    sock.binaryType = "arraybuffer";
    ws.current = sock;
    sock.onopen = () => {
      retries.current = 0;
      setRetryIn(null);
      setState("open");
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== "string") {
        t.write(new Uint8Array(e.data as ArrayBuffer));
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "reset") {
        t.reset();
        setState("open");
      } else if (msg.type === "exit") {
        if (kind === "shell") t.write(`\r\n\x1b[2m[shell exited${msg.code != null ? ` with code ${msg.code}` : ""}, press any key to restart]\x1b[0m\r\n`);
        setState("exited");
      } else if (msg.type === "error") {
        t.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      }
    };
    sock.onclose = () => {
      if (ws.current === sock) setState((s) => (s === "exited" ? s : "closed"));
    };
    return () => {
      ws.current = null;
      sock.close();
    };
  }, [slug, kind, attempt]);

  useEffect(() => {
    if (state !== "closed") return;
    const delay = Math.min(30_000, 1000 * 2 ** retries.current);
    setRetryIn(Math.round(delay / 1000));
    const t = setTimeout(() => {
      retries.current += 1;
      setAttempt((n) => n + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [state]);

  // Run a requested command once the shell is live. Ctrl+U clears anything half-typed first.
  useEffect(() => {
    if (command && command.n !== sentCommand.current) pendingCommand.current = command;
    const c = pendingCommand.current;
    if (!c || state !== "open") return;
    // Give the replay of recent output a moment so the command shows after the prompt.
    const t = setTimeout(() => {
      send({ type: "input", data: `\x15${c.text}\r` });
      sentCommand.current = c.n;
      pendingCommand.current = null;
      onCommandSent?.();
      term.current?.focus();
    }, 250);
    return () => clearTimeout(t);
  }, [command?.n, state]);

  useEffect(() => {
    if (!restartSignal) return;
    if (ws.current?.readyState === WebSocket.OPEN) send({ type: "restart" });
    else setAttempt((n) => n + 1);
    term.current?.focus();
  }, [restartSignal]);

  // Hidden panes have no size; refit and focus when the tab is shown again.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {}
      term.current?.focus();
    });
  }, [active]);

  const startAgain = () => {
    send({ type: "restart", resume: true });
    term.current?.focus();
  };

  return (
    <div className={kind === "claude" ? "terminal-view dark" : "terminal-view"}>
      <div ref={host} className="terminal-host" />
      {state === "exited" && kind === "claude" && (
        <div className="terminal-banner" role="status">
          Claude session ended.{" "}
          <button className="link-btn" onClick={startAgain}>Start again</button>
        </div>
      )}
      {state === "closed" && (
        <div className="terminal-banner" role="status">
          Disconnected from the {kind === "claude" ? "Claude chat" : "shell"}.{retryIn !== null && ` Reconnecting in ${retryIn}s…`}{" "}
          <button className="link-btn" onClick={() => { retries.current = 0; setAttempt((n) => n + 1); }}>Reconnect now</button>
        </div>
      )}
    </div>
  );
}
