import { useEffect, useRef, useState } from "react";
import type { Profile } from "./api";
import { FilesView } from "./FilesView";
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
export default function Dock({ profile, pty, onClose }: { profile: Profile; pty: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(() => (stored(TAB_KEY) === "files" ? "files" : "terminal"));
  const [height, setHeight] = useState(() => clampHeight(Number(stored(HEIGHT_KEY)) || 320));
  const [restart, setRestart] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => store(TAB_KEY, tab), [tab]);
  useEffect(() => store(HEIGHT_KEY, String(height)), [height]);

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
      <div className="dock-resize" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onDoubleClick={() => setHeight(clampHeight(320))} title="Drag to resize" />
      <div className="dock-head">
        <div className="tabs">
          <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>Terminal</button>
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>Files</button>
        </div>
        <span className="dock-path" title={profile.path}>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</span>
        <div className="spacer" />
        {tab === "terminal" && pty && (
          <button className="btn ghost small" onClick={() => setRestart((n) => n + 1)} title="Kill this shell and start a new one">
            Restart
          </button>
        )}
        {tab === "files" && (
          <button className="btn ghost small" onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
        )}
        <button className="btn ghost small" onClick={onClose} title="Hide panel (Ctrl+`). The shell keeps running." aria-label="Hide panel">
          ✕
        </button>
      </div>
      <div className="dock-body">
        <div className="dock-pane" hidden={tab !== "terminal"}>
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} active={tab === "terminal"} restartSignal={restart} />
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
    </section>
  );
}
