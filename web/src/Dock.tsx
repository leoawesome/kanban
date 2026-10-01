import { useEffect, useRef, useState } from "react";
import type { Profile } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { FilesView } from "./FilesView";
import { CloseIcon, RefreshIcon } from "./icons";
import { TerminalView } from "./TerminalView";

type Tab = "terminal" | "files";
const TAB_KEY = "ckanban.dock.tab";
const HEIGHT_KEY = "ckanban.dock.height";
const MIN_HEIGHT = 140;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const clampHeight = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 120, h)));

/**
 * Bottom panel for the selected profile's folder: an interactive shell and a read-only file browser.
 * Closing it only hides it; the shell keeps running on the server and reattaches next time.
 */
export default function Dock({ profile, pty, onClose, command, onCommandSent }: {
  profile: Profile;
  pty: boolean;
  onClose: () => void;
  /** Typed into the shell and run (e.g. from Connections); `n` changes for each new request. */
  command?: { text: string; n: number } | null;
  onCommandSent?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => (stored(TAB_KEY) === "files" ? "files" : "terminal"));
  const [height, setHeight] = useState(() => clampHeight(Number(stored(HEIGHT_KEY)) || 320));
  const [restart, setRestart] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => store(TAB_KEY, tab), [tab]);
  useEffect(() => store(HEIGHT_KEY, String(height)), [height]);
  useEffect(() => {
    if (command) setTab("terminal");
  }, [command?.n]);

  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setHeight((h) => clampHeight(h + (e.key === "ArrowUp" ? step : -step)));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) setHeight(clampHeight(drag.current.h + drag.current.y - e.clientY));
  };
  const onPointerUp = () => (drag.current = null);

  return (
    <section className="dock" style={{ height }} aria-label="Terminal and files">
      <div className="dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize panel" tabIndex={0}
        aria-valuenow={height} aria-valuemin={MIN_HEIGHT}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onHandleKey}
        onDoubleClick={() => setHeight(clampHeight(320))} title="Drag (or ↑↓) to resize · double-click to reset" />
      <div className="dock-head">
        <div className="tabs" role="tablist" aria-label="Panel">
          <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>Terminal</button>
          <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>Files</button>
        </div>
        <span className="dock-path" title={profile.path}>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</span>
        <div className="spacer" />
        {tab === "terminal" && pty && (
          <button className="btn ghost small" onClick={() => setConfirmRestart(true)} title="Kill this shell and start a new one">
            Restart
          </button>
        )}
        {tab === "files" && (
          <button className="btn ghost small icon-label" onClick={() => setRefresh((n) => n + 1)}><RefreshIcon size={12} /> Refresh</button>
        )}
        <button className="icon-btn" onClick={onClose} title="Hide panel (Ctrl+`). The shell keeps running." aria-label="Hide terminal and files panel">
          <CloseIcon />
        </button>
      </div>
      <div className="dock-body">
        <div className="dock-pane" hidden={tab !== "terminal"}>
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} active={tab === "terminal"} restartSignal={restart} command={command ?? null} onCommandSent={onCommandSent} />
          ) : (
            <div className="empty small">
              The terminal needs Bun 1.3.5 or newer on the machine running the daemon. Upgrade Bun
              (<code>bun upgrade</code> or <code>brew upgrade bun</code>), then run <code>ckanban restart</code>.
            </div>
          )}
        </div>
        <div className="dock-pane" hidden={tab !== "files"}>
          <FilesView key={profile.slug} slug={profile.slug} refreshSignal={refresh} />
        </div>
      </div>
      {confirmRestart && (
        <ConfirmDialog title="Restart the shell?" confirmLabel="Restart" busyLabel="Restarting…"
          onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); setRestart((n) => n + 1); }}>
          <p>Stops whatever is running in this terminal and starts a fresh shell in <code>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</code>.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
