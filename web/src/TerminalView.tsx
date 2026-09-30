import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { shellSocketUrl } from "./api";

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

type State = "connecting" | "open" | "exited" | "closed";

/** xterm.js wired to the profile's shell over a WebSocket. Binary frames are output; JSON text frames are control. */
export function TerminalView({ slug, active, restartSignal }: { slug: string; active: boolean; restartSignal: number }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

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
      theme: themeFromCss(),
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
      if (stateRef.current === "exited") send({ type: "restart" });
      else send({ type: "input", data });
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
    const onScheme = () => (t.options.theme = themeFromCss());
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
    const sock = new WebSocket(shellSocketUrl(slug, t.cols, t.rows));
    sock.binaryType = "arraybuffer";
    ws.current = sock;
    sock.onopen = () => setState("open");
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
        t.write(`\r\n\x1b[2m[shell exited${msg.code != null ? ` with code ${msg.code}` : ""}, press any key to restart]\x1b[0m\r\n`);
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
  }, [slug, attempt]);

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

  return (
    <div className="terminal-view">
      <div ref={host} className="terminal-host" />
      {state === "closed" && (
        <div className="terminal-banner">
          Disconnected from the shell. <button className="link-btn" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
        </div>
      )}
    </div>
  );
}
