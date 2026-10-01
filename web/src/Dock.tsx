import { useEffect, useRef, useState } from "react";
import { api, type Profile, type QuickChat } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { FilesView } from "./FilesView";
import { CloseIcon, RefreshIcon } from "./icons";
import { TerminalView } from "./TerminalView";
import { toast } from "./toast";

export type DockTab = "terminal" | "files" | "claude";
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

const TABS: [DockTab, string][] = [["terminal", "Terminal"], ["files", "Files"], ["claude", "Claude"]];
const isTab = (v: string | null): v is DockTab => TABS.some(([t]) => t === v);

const clampHeight = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 120, h)));

/**
 * Bottom panel for the selected profile's folder: an interactive shell, a read-only file browser and a
 * quick Claude chat (interactive `claude`, no ticket). Closing it only hides it; the shell and the chat
 * keep running on the server and reattach next time.
 */
export default function Dock({ profile, pty, onClose, command, onCommandSent, tabRequest, onOpenTicket }: {
  profile: Profile;
  pty: boolean;
  onClose: () => void;
  /** Typed into the shell and run (e.g. from Connections); `n` changes for each new request. */
  command?: { text: string; n: number } | null;
  onCommandSent?: () => void;
  /** Switch to this tab (e.g. from a shortcut); `n` changes for each new request. */
  tabRequest?: { tab: DockTab; n: number } | null;
  onOpenTicket?: (id: string) => void;
}) {
  const [tab, setTab] = useState<DockTab>(() => {
    const t = stored(TAB_KEY);
    return isTab(t) ? t : "terminal";
  });
  const [height, setHeight] = useState(() => clampHeight(Number(stored(HEIGHT_KEY)) || 320));
  const [restart, setRestart] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [chatRestart, setChatRestart] = useState(0);
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [chat, setChat] = useState<QuickChat | null>(null);
  const [makingTicket, setMakingTicket] = useState(false);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => store(TAB_KEY, tab), [tab]);
  useEffect(() => store(HEIGHT_KEY, String(height)), [height]);
  useEffect(() => {
    if (command) setTab("terminal");
  }, [command?.n]);
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest?.n]);

  // Make ticket needs the chat's session file, which appears after the first message: poll while visible.
  const loadChat = () => api.quickChat(profile.slug).then(setChat).catch(() => setChat(null));
  useEffect(() => {
    setChat(null);
    if (tab !== "claude" || !pty) return;
    loadChat();
    const timer = setInterval(loadChat, 3000);
    return () => clearInterval(timer);
  }, [tab, profile.slug, pty, chatRestart]);

  const makeTicket = async () => {
    if (!chat?.sessionId || !chat.started) return;
    setMakingTicket(true);
    try {
      const title = chat.title?.trim() || `Quick chat ${new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
      const t = await api.createTicket(profile.slug, {
        title, body: "Started from a quick Claude chat in the dock.", status: "backlog", sessionId: chat.sessionId,
      });
      // The ticket owns that session now; give the dock a fresh one so two `claude`s never share a session file.
      setChatRestart((n) => n + 1);
      toast("Ticket created from the chat");
      onOpenTicket?.(t.id);
    } catch (e) {
      toast(`Couldn't create the ticket: ${(e as Error).message}`, { tone: "error" });
    } finally {
      setMakingTicket(false);
    }
  };

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
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <span className="dock-path" title={profile.path}>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</span>
        <div className="spacer" />
        {tab === "terminal" && pty && (
          <button className="btn ghost small" onClick={() => setConfirmRestart(true)} title="Kill this shell and start a new one">
            Restart
          </button>
        )}
        {tab === "claude" && pty && (
          <>
            <button className="btn ghost small" onClick={makeTicket} disabled={!chat?.started || makingTicket}
              title={chat?.started ? "Turn this chat into a Backlog ticket (the dock starts a fresh chat)" : "Send Claude a message first"}>
              {makingTicket ? "Creating…" : "Make ticket"}
            </button>
            <button className="btn ghost small" onClick={() => setConfirmNewChat(true)} title="End this chat and start an empty one">
              New chat
            </button>
          </>
        )}
        {tab === "files" && (
          <button className="btn ghost small icon-label" onClick={() => setRefresh((n) => n + 1)}><RefreshIcon size={12} /> Refresh</button>
        )}
        <button className="icon-btn" onClick={onClose} title="Hide panel (Ctrl+`). The shell and Claude chat keep running." aria-label="Hide terminal and files panel">
          <CloseIcon />
        </button>
      </div>
      <div className="dock-body">
        <div className="dock-pane" hidden={tab !== "terminal"}>
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} active={tab === "terminal"} restartSignal={restart} command={command ?? null} onCommandSent={onCommandSent} />
          ) : (
            <PtyUnsupported />
          )}
        </div>
        <div className="dock-pane" hidden={tab !== "claude"}>
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} kind="claude" active={tab === "claude"} restartSignal={chatRestart} command={null} />
          ) : (
            <PtyUnsupported />
          )}
        </div>
        <div className="dock-pane" hidden={tab !== "files"}>
          <FilesView key={profile.slug} slug={profile.slug} refreshSignal={refresh} />
        </div>
      </div>
      {confirmNewChat && (
        <ConfirmDialog title="Start a new chat?" confirmLabel="New chat" busyLabel="Starting…"
          onCancel={() => setConfirmNewChat(false)} onConfirm={() => { setConfirmNewChat(false); setChatRestart((n) => n + 1); }}>
          <p>Ends the current Claude chat and starts an empty one. The old conversation stays in Claude Code's history.</p>
        </ConfirmDialog>
      )}
      {confirmRestart && (
        <ConfirmDialog title="Restart the shell?" confirmLabel="Restart" busyLabel="Restarting…"
          onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); setRestart((n) => n + 1); }}>
          <p>Stops whatever is running in this terminal and starts a fresh shell in <code>{profile.path.replace(/^\/Users\/[^/]+/, "~")}</code>.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PtyUnsupported() {
  return (
    <div className="empty small">
      The terminal needs Bun 1.3.5 or newer on the machine running the daemon. Upgrade Bun
      (<code>bun upgrade</code> or <code>brew upgrade bun</code>), then run <code>ckanban restart</code>.
    </div>
  );
}
