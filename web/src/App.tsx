import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, copy, COLUMNS, onReconnect, subscribe, waitsForSlot, type Health, type InboxItem, type McpState, type Profile, type Schedule, type Status, type Ticket } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { BugReportDialog } from "./BugReportDialog";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { HeaderMenu } from "./HeaderMenu";
import { BugIcon, ChatIcon, CheckIcon, ClockIcon, CloseIcon, CopyIcon, GearIcon, KeyboardIcon, Logo, PlugIcon, SearchIcon, TerminalIcon } from "./icons";
import { Inbox } from "./Inbox";
import { UsagePill } from "./UsagePill";
import { anyLayerOpen } from "./layers";
import { Board, boardOrder } from "./Board";
import { NewTicketDialog } from "./NewTicketDialog";
import { ProfileDialog } from "./ProfileDialog";
import { SchedulesDialog } from "./SchedulesDialog";
import { Select } from "./Select";
import { BoardSwitcher, QuickSwitcher, ShortcutsDialog } from "./Shortcuts";
import { boardDigit, cardDir, stepBoard, stepCard, type CardPos } from "./keynav";
import { TicketDrawer } from "./TicketDrawer";
import { toast, Toaster } from "./toast";

import type { DockTab } from "./Dock";

// xterm.js and highlight.js only load once the panel is opened. After an upgrade the old chunk is gone:
// reload once to get the new build instead of blanking the whole page.
const Dock = lazy(() => import("./Dock").then((m) => {
  sessionStorage.removeItem("ckanban.chunkReload");
  return m;
}, () => {
  if (!sessionStorage.getItem("ckanban.chunkReload")) {
    sessionStorage.setItem("ckanban.chunkReload", "1");
    location.reload();
  }
  return { default: () => <div className="dock dock-failed">Couldn't load the terminal panel. Reload the page.</div> };
}));
const DOCK_OPEN = "ckanban.dock.open";

const LAST_PROFILE = "ckanban.profile";

/** URL hash is the source of truth for what's open: #/<profile> or #/<profile>/<ticketId>. */
function parseHash(): { slug: string | null; ticket: string | null } {
  const [, slug, ticket] = decodeURIComponent(location.hash.replace(/^#/, "")).split("/");
  return { slug: slug || null, ticket: ticket || null };
}

function hashFor(slug: string | null, ticket?: string | null): string {
  if (!slug) return "#/";
  return `#/${encodeURIComponent(slug)}${ticket ? `/${encodeURIComponent(ticket)}` : ""}`;
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Cards on screen, per expanded column, in board order. */
function cardGrid(): HTMLElement[][] {
  return [...document.querySelectorAll<HTMLElement>(".board > .column:not(.collapsed)")]
    .map((c) => [...c.querySelectorAll<HTMLElement>(".column-body > .sortable-card")]);
}

function focusedCard(grid: HTMLElement[][]): CardPos | null {
  const el = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card");
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col].findIndex((c) => c === el);
    if (row >= 0) return { col, row };
  }
  return null;
}

function focusCard(pos: CardPos | null, grid = cardGrid()) {
  const col = pos && grid[pos.col];
  const el = col && col[Math.min(pos.row, col.length - 1)];
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Board filter chips; several on = tickets matching any of them. */
const FILTERS = [
  { id: "you", label: "Needs you", test: (t: Ticket) => !!t.attention && t.status !== "in_progress" && !t.running },
  { id: "running", label: "Running", test: (t: Ticket) => t.status === "in_progress" || !!t.running },
  { id: "pr", label: "Has PR", test: (t: Ticket) => !!t.prUrl },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const DISMISSED = "ckanban.dismissedBanners";
function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED) ?? "[]"));
  } catch {
    return new Set();
  }
}

const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Background load: retry once after a few seconds, then say so (quietly) instead of failing silently. */
function quiet<T>(load: () => Promise<T>, what: string, set: (v: T) => void) {
  load().then(set).catch(() => {
    setTimeout(() => load().then(set).catch(() => toast(`Couldn't load ${what}. It will retry when the connection comes back.`, { tone: "error" })), 3000);
  });
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [slug, setSlug] = useState<string | null>(parseHash().slug ?? readLast());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      return localStorage.getItem(DOCK_OPEN) === "1";
    } catch {
      return false;
    }
  });
  const [openId, setOpenId] = useState<string | null>(parseHash().ticket);
  // True when the open ticket was pushed onto browser history by us, so closing can go Back.
  const pushedOpen = useRef(false);
  // Board shown before that push: going Back to a different board would leave the ticket's board.
  const pushedFrom = useRef<string | null>(null);
  // The open ticket was reached with prev/next: the drawer stays put instead of sliding in again.
  const stepped = useRef(false);
  // Ticket order prev/next follows, frozen when the drawer opens (see below).
  const [navOrder, setNavOrder] = useState<string[] | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileDialog, setProfileDialog] = useState<"new" | "edit" | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const setError = (msg: string) => toast(msg, { tone: "error" });
  const [filters, setFilters] = useState<Set<FilterId>>(new Set());
  const [dismissed, setDismissed] = useState(readDismissed);
  const [shortcuts, setShortcuts] = useState(false);
  const [bugReport, setBugReport] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [boardSwitcher, setBoardSwitcher] = useState(false);
  // Command to type into the dock's terminal (e.g. "claude mcp login x"); n makes repeats count.
  const [dockCommand, setDockCommand] = useState<{ text: string; n: number } | null>(null);
  // Tab the dock should switch to (C opens the quick Claude chat).
  const [dockTab, setDockTab] = useState<{ tab: DockTab; n: number } | null>(null);
  // Tab the open dock shows (reported by the dock), for the header buttons' on state.
  const [dockShown, setDockShown] = useState<DockTab | null>(null);
  const chatOpen = dockOpen && dockShown === "claude";
  const openDockOn = (tab: DockTab) => {
    setDockOpen(true);
    setDockTab({ tab, n: Date.now() });
  };
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [connections, setConnections] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const schedulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [version, setVersion] = useState<{ version: string; latest: string | null; updateAvailable: boolean } | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await api.profiles();
    setProfiles(ps);
    setSlug((cur) => (cur && ps.some((p) => p.slug === cur) ? cur : ps[0]?.slug ?? null));
  }, []);

  const slugRef = useRef(slug);
  slugRef.current = slug;
  const loadSchedules = useCallback((board: string) => api.schedules(board).then((list) => {
    // Ignore a late answer for a board we already left.
    if (slugRef.current === board) setSchedules(list);
  }).catch(() => {}), []);
  // Fires and ticket changes move "next run", "running" and errors: refetch for the computed fields.
  const refreshSchedulesSoon = useCallback((board: string) => {
    if (schedulesTimer.current) return;
    schedulesTimer.current = setTimeout(() => {
      schedulesTimer.current = null;
      loadSchedules(board);
    }, 300);
  }, [loadSchedules]);

  const loadInbox = useCallback(() => quiet(api.inbox, "the inbox", setInbox), []);
  const refreshInboxSoon = useCallback(() => {
    if (inboxTimer.current) return;
    inboxTimer.current = setTimeout(() => {
      inboxTimer.current = null;
      loadInbox();
    }, 400);
  }, [loadInbox]);

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    loadInbox();
    quiet(api.health, "tool checks", setHealth);
    quiet(api.version, "the version", setVersion);
    quiet(api.mcp, "connections", setMcp);
  }, [loadProfiles, loadInbox]);

  // Browser Back/Forward and pasted links drive the open board and ticket.
  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      if (h.slug) setSlug(h.slug);
      setOpenId(h.ticket);
      stepped.current = false;
      if (!h.ticket) pushedOpen.current = false;
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Keep the URL in step with the board shown (replace, so switching boards doesn't pile up history).
  useEffect(() => {
    if (slug && parseHash().slug !== slug) history.replaceState(null, "", hashFor(slug, openId));
  }, [slug]);

  const openTicket = useCallback((id: string, board = slug) => {
    if (!board) return;
    pushedOpen.current = true;
    pushedFrom.current = slug;
    location.hash = hashFor(board, id);
  }, [slug]);

  // Prev/next in the drawer: replace the history entry, so one Close or Back still returns to the board.
  const stepTicket = useCallback((id: string) => {
    stepped.current = true;
    history.replaceState(null, "", hashFor(slug, id));
    setOpenId(id);
  }, [slug]);

  const closeTicket = useCallback(() => {
    if (pushedOpen.current && pushedFrom.current === slug) history.back();
    else {
      pushedOpen.current = false;
      history.replaceState(null, "", hashFor(slug));
      setOpenId(null);
    }
  }, [slug]);

  // After the daemon restarts or the laptop wakes, events were missed: reload everything.
  // A pending daemon restart holds new runs on every board: show it so queued cards don't look stuck.
  const [restart, setRestart] = useState({ pending: false, waiting: 0 });
  useEffect(() => { api.restartState().then(setRestart).catch(() => {}); }, []);

  useEffect(() => onReconnect(() => {
    api.restartState().then(setRestart).catch(() => {});
    loadProfiles().catch(() => {});
    loadInbox();
    api.mcp().then(setMcp).catch(() => {});
    if (slug) {
      api.tickets(slug).then(setTickets).catch(() => {});
      loadSchedules(slug);
    }
  }), [slug, loadProfiles, loadInbox, loadSchedules]);

  const needYou = inbox.length;
  useEffect(() => {
    document.title = needYou ? `(${needYou}) ckanban` : "ckanban";
  }, [needYou]);

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_OPEN, dockOpen ? "1" : "0");
    } catch {}
  }, [dockOpen]);
  // A tab request is one-shot: reopening the dock later keeps the user's last tab.
  useEffect(() => {
    if (!dockOpen) setDockTab(null);
  }, [dockOpen]);

  // Board switching (B picker, [ ] prev/next, 1…9) leaves the open ticket: it belongs to the old board.
  const switchBoard = useCallback((to: string) => {
    if (to === slugRef.current) return;
    pushedOpen.current = false;
    setOpenId(null);
    setSlug(to);
  }, []);
  // Latest values for the window key handler below, which is bound once per dialog state.
  const live = useRef({ profiles, tickets, markDone: (_id: string) => {} });

  // Shortcuts: N new ticket, / search, ? cheatsheet, C quick Claude chat, ⌘K jump to a ticket, Ctrl+` terminal & files,
  // B board picker, [ ] previous / next board, 1…9 board N, J/K/H/L or arrows select a card, D marks a Review card done.
  // Esc is handled by the panel and dialogs (one layer at a time, see layers.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        setDockOpen((o) => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        if (slug && !anyLayerOpen()) setSwitcher(true);
        return;
      }
      const boards = live.current.profiles ?? [];
      const at = boards.findIndex((p) => p.slug === slug);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (openId || profileDialog || newTicket || connections || schedulesOpen || anyLayerOpen() || document.querySelector(".overlay")) return;
      // Plain 1…9 (Alt+digit is taken by Chrome's tab switching); the ticket panel's questions form uses digits too.
      const digit = e.shiftKey || e.isComposing ? null : boardDigit(e.code);
      if (digit !== null) {
        if (!boards[digit]) return;
        e.preventDefault();
        switchBoard(boards[digit].slug);
        return;
      }
      const dir = e.shiftKey && e.key.startsWith("Arrow") ? null : cardDir(e.key);
      if (dir) {
        // A picked-up card (Space) moves with the arrows instead: leave those to the drag.
        if (!slug || e.defaultPrevented || document.querySelector(".sortable-card[aria-pressed='true']")) return;
        // Arrows on a focused button or menu trigger belong to it; J/K/H/L work from anywhere.
        const focus = document.activeElement;
        if (e.key.startsWith("Arrow") && focus && focus !== document.body && !focus.closest(".sortable-card")) return;
        const grid = cardGrid();
        const next = stepCard(grid.map((c) => c.length), focusedCard(grid), dir);
        if (!next) return;
        e.preventDefault();
        focusCard(next, grid);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (slug) setNewTicket(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcuts(true);
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (slug) openDockOn("claude");
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (boards.length) setBoardSwitcher(true);
      } else if (e.key === "[" || e.key === "]") {
        const to = boards[stepBoard(boards.length, at, e.key === "]" ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        switchBoard(to.slug);
      } else if (e.key === "d" || e.key === "D") {
        const id = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card")?.getAttribute("data-ticket");
        if (!id) return;
        e.preventDefault();
        live.current.markDone(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, profileDialog, newTicket, connections, schedulesOpen, slug, switchBoard]);

  const runInTerminal = useCallback((text: string) => {
    setDockOpen(true);
    setDockCommand({ text, n: Date.now() });
  }, []);

  const dismiss = (key: string) => setDismissed((d) => {
    const next = new Set(d).add(key);
    try {
      sessionStorage.setItem(DISMISSED, JSON.stringify([...next]));
    } catch {}
    return next;
  });

  useEffect(() => {
    if (!slug) return;
    try {
      localStorage.setItem(LAST_PROFILE, slug);
    } catch {}
    setTickets([]);
    setSchedules(null);
    api.tickets(slug).then(setTickets).catch((e) => setError(e.message));
    loadSchedules(slug);
  }, [slug, loadSchedules]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "mcp.updated") {
          setMcp(e.state);
          return;
        }
        if (e.type === "restart.updated") {
          setRestart({ pending: e.pending, waiting: e.waiting });
          return;
        }
        if (e.type === "profile.updated") {
          loadProfiles().catch(() => {});
          refreshInboxSoon();
          return;
        }
        if (e.type === "ticket.updated" || e.type === "ticket.deleted" || e.type === "session.updated") refreshInboxSoon();
        if (e.type === "schedule.updated" && e.profile === slug) refreshSchedulesSoon(slug);
        if (e.type === "ticket.updated" && e.profile === slug && e.ticket.scheduleId) refreshSchedulesSoon(slug);
        if (e.type === "ticket.updated" && e.profile === slug) {
          setTickets((ts) => {
            const i = ts.findIndex((t) => t.id === e.ticket.id);
            const merged = { ...ts[i], ...e.ticket };
            if (i < 0) return [...ts, merged];
            const next = ts.slice();
            next[i] = merged;
            return next;
          });
        }
        if (e.type === "session.updated" && e.profile === slug) {
          setTickets((ts) => ts.map((t) => (t.id === e.id ? { ...t, session: e.session } : t)));
        }
        if (e.type === "ticket.deleted" && e.profile === slug) {
          setTickets((ts) => ts.filter((t) => t.id !== e.id));
        }
      }),
    [slug, loadProfiles, refreshInboxSoon, refreshSchedulesSoon],
  );

  const profile = useMemo(() => profiles?.find((p) => p.slug === slug) ?? null, [profiles, slug]);
  const open = tickets.find((t) => t.id === openId) ?? null;
  const q = query.trim().toLowerCase();
  const activeFilters = FILTERS.filter((f) => filters.has(f.id));
  const shownTickets = tickets.filter((t) =>
    (!q || `${t.title}\n${t.body}`.toLowerCase().includes(q)) && (!activeFilters.length || activeFilters.some((f) => f.test(t))));
  const filtering = !!q || activeFilters.length > 0;
  // Prev/next walk the visible tickets in board order as it was when the drawer opened, so moving the open
  // ticket (e.g. Backlog to Done) doesn't send Next into its new column. Stepping keeps that order;
  // deleted tickets are skipped.
  const liveOrder = open ? boardOrder(shownTickets).map((t) => t.id) : [];
  const orderMissing = !!openId && !navOrder?.includes(openId);
  useEffect(() => {
    if (!openId) setNavOrder(null);
    else if (!stepped.current || orderMissing) setNavOrder(liveOrder);
  }, [openId, orderMissing, tickets.length > 0]);
  // navOrder is null until the effect above runs (and whenever no ticket is open): fall back to the live order.
  const order = (orderMissing ? liveOrder : navOrder ?? liveOrder).filter((id) => id === openId || tickets.some((t) => t.id === id));
  const at = open ? order.indexOf(open.id) : -1;
  const prevId = at > 0 ? order[at - 1] : null;
  const nextId = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  const perBoard = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inbox) m.set(i.profile, (m.get(i.profile) ?? 0) + 1);
    return m;
  }, [inbox]);

  // Without an order the server puts the ticket where a column entry goes (e.g. top of Done).
  const move = async (id: string, status: Status, order?: number, undo = true) => {
    const board = slug!;
    const before = tickets.find((t) => t.id === id);
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, ...(order === undefined ? {} : { order }) } : t)));
    try {
      await api.updateTicket(board, id, order === undefined ? { status } : { status, order });
      if (undo && before && before.status !== status) {
        const label = COLUMNS.find((c) => c.id === status)?.label ?? status;
        toast(<>Moved <b>{before.title}</b> to {label}</>, {
          action: { label: "Undo", run: () => { if (slugRef.current === board) move(id, before.status, before.order, false); } },
        });
      }
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      api.tickets(board).then(setTickets).catch(() => {});
    }
  };

  // D on a focused Review card; focus stays at the same spot on the board for the next key.
  const markDone = (id: string) => {
    if (tickets.find((t) => t.id === id)?.status !== "review") return;
    const pos = focusedCard(cardGrid());
    void move(id, "done");
    setTimeout(() => focusCard(pos));
  };
  live.current = { profiles, tickets, markDone };

  const mcpAttention = mcp?.servers.filter((s) => s.attention).length ?? 0;
  const scheduleErrors = schedules?.filter((s) => s.lastError).length ?? 0;
  const missing = health ? (["claude", "git", "gh"] as const).filter((k) => !health[k]) : [];
  // Runs holding a slot, as the server counts them (Planning and replies to other tickets don't take one).
  const running = tickets.filter((t) => t.holdsSlot).length;
  const queued = tickets.filter((t) => t.status === "ready" || waitsForSlot(t)).length;

  const updateKey = `update:${version?.latest}`;
  const pathKey = `path:${missing.join(",")}`;
  const folderKey = `folder:${profile?.slug}`;
  const toggleFilter = (id: FilterId) => setFilters((f) => {
    const next = new Set(f);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">ckanban</span>
          <span className="brand-tagline">Kanban for Claude Code</span>
        </div>
        {profiles && profiles.length > 0 && (
          <Select
            className="profile-select"
            ariaLabel="Profile"
            value={slug ?? ""}
            onChange={setSlug}
            menuClassName="profile-menu"
            menuMaxHeight={440}
            options={profiles.map((p) => ({ value: p.slug, label: p.name, hint: tildePath(p.path) }))}
            renderOption={(o, selected) => (
              <>
                <span className="profile-avatar" style={{ background: avatarColor(o.value) }} aria-hidden>{avatarLetter(String(o.label))}</span>
                <span className="profile-body">
                  <span className="profile-row">
                    <span className="profile-name">{o.label}</span>
                    {!!perBoard.get(o.value) && <span className="need-chip">{perBoard.get(o.value)} need you</span>}
                  </span>
                  <span className="profile-path" title={profiles.find((p) => p.slug === o.value)?.path}>{o.hint}</span>
                </span>
                <span className="profile-check" aria-hidden>{selected && <CheckIcon size={13} />}</span>
              </>
            )}
            renderValue={() => profile?.name}
            footer={[
              ...(profile ? [{
                label: "Copy folder path",
                icon: <CopyIcon size={12} />,
                onSelect: () => { copy(profile.path).then(() => toast(<>Copied <code>{tildePath(profile.path)}</code></>, { tone: "ok" })); },
              }] : []),
              { label: "New profile…", onSelect: () => setProfileDialog("new") },
            ]}
          />
        )}
        {profile && (
          <span className="pill" title={`At most ${profile.maxParallel} tickets run at the same time on this board`}>
            {running}/{profile.maxParallel} running{queued > 0 && <> · {queued} queued</>}
          </span>
        )}
        <UsagePill />
        {restart.pending && (
          <span className="pill warn" title="The daemon restarts once every active run (on any board) has finished. Until then nothing new starts: queued tickets, chat replies and Planning interviews wait.">
            Restart pending{restart.waiting > 0 ? ` · waiting for ${restart.waiting} ${restart.waiting === 1 ? "run" : "runs"}` : ""}
          </span>
        )}
        <div className="spacer" />
        <Inbox items={inbox} onPick={(i) => {
          if (i.profile !== slug) setSlug(i.profile);
          openTicket(i.id, i.profile);
        }} />
        {profile && (
          <button className={`btn ghost icon-label${dockOpen && !chatOpen ? " on" : ""}`}
            onClick={() => (chatOpen ? openDockOn("terminal") : setDockOpen((o) => !o))}
            aria-pressed={dockOpen && !chatOpen} title="Terminal and files for this folder (Ctrl+`)" aria-label="Terminal and files">
            <TerminalIcon /><span className="label">Terminal & files</span>
          </button>
        )}
        {profile && (
          <button className={`btn ghost icon-label${chatOpen ? " on" : ""}`}
            onClick={() => (chatOpen ? setDockOpen(false) : openDockOn("claude"))}
            aria-pressed={chatOpen} title="Quick chat with Claude in this folder, no ticket needed (C)" aria-label="Quick Claude chat">
            <ChatIcon /><span className="label">Claude</span>
          </button>
        )}
        {profile && (
          <button className="btn primary" onClick={() => setNewTicket(true)} title="New ticket (N)">
            New ticket
          </button>
        )}
        <HeaderMenu alert={scheduleErrors > 0 || mcpAttention > 0} items={[
          ...(profile ? [{
            label: "Schedules", icon: <ClockIcon />, onSelect: () => setSchedulesOpen(true),
            title: scheduleErrors ? `${scheduleErrors} schedule${scheduleErrors === 1 ? "" : "s"} could not start their last run` : "Recurring tickets on a cron schedule",
            badge: scheduleErrors > 0 ? <span className="need-chip">{scheduleErrors}</span>
              : schedules && schedules.length > 0 ? <span className="muted small">{schedules.filter((s) => s.enabled).length} active</span> : null,
          }] : []),
          {
            label: "Connections", icon: <PlugIcon />, onSelect: () => setConnections(true), separator: true,
            title: mcpAttention ? `${mcpAttention} MCP server${mcpAttention === 1 ? "" : "s"} failed or need you to log in again` : "Claude Code MCP servers",
            badge: mcpAttention > 0 ? <span className="need-chip">{mcpAttention}</span> : null,
          },
          ...(profile ? [{ label: "Board settings", icon: <GearIcon />, onSelect: () => setProfileDialog("edit") }] : []),
          { label: "Keyboard shortcuts", hint: "?", icon: <KeyboardIcon />, onSelect: () => setShortcuts(true) },
          { label: "Report a bug", icon: <BugIcon />, onSelect: () => setBugReport(true) },
        ]} footer={version && version.version !== "dev" ? `ckanban v${version.version} · by Leo` : "by Leo"} />
      </header>

      {version?.updateAvailable && !dismissed.has(updateKey) && (
        <div className="banner info" role="status">
          <span>ckanban v{version.latest} is available (you have v{version.version}). Run <code>ckanban update</code> in a terminal.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(updateKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {missing.length > 0 && !dismissed.has(pathKey) && (
        <div className={`banner ${missing.includes("claude") ? "warn" : "info"}`} role="status">
          <span>
            {missing.includes("claude") && <><b>claude</b> not found on PATH: tickets cannot run. </>}
            {missing.includes("git") && <><b>git</b> not found: tickets still run, directly in the board folder without per-ticket worktrees. </>}
            {missing.includes("gh") && (
              <>
                <b>gh</b> (GitHub CLI) is optional: tickets run without it; it is only needed to open and track pull requests.
                {" "}To add it: <code>brew install gh</code>, then <code>gh auth login</code> (<a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>).
              </>
            )}
          </span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(pathKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {profile && profile.pathExists === false && !dismissed.has(folderKey) && (
        <div className="banner warn" role="status">
          <span>Profile folder <code>{profile.path}</code> does not exist. Tickets will not be picked up.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(folderKey)}><CloseIcon size={12} /></button>
        </div>
      )}

      {profiles === null ? (
        <div className="empty"><span className="spinner" /> Loading boards…</div>
      ) : !profile ? (
        <div className="empty">
          <h2>No profiles yet</h2>
          <p>A profile is a folder (usually a git repo) with its own board.</p>
          <button className="btn primary" onClick={() => setProfileDialog("new")}>
            Create profile
          </button>
        </div>
      ) : (
        <>
          <div className="board-bar">
            <div className="search">
              <SearchIcon className="icon search-icon" />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tickets"
                aria-label="Search tickets on this board" aria-keyshortcuts="/"
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); if (query) setQuery(""); else e.currentTarget.blur(); } }} />
              {query ? (
                <button className="search-clear" aria-label="Clear search" title="Clear (Esc)"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
                  <CloseIcon size={12} />
                </button>
              ) : <kbd className="search-kbd" aria-hidden>/</kbd>}
            </div>
            <div className="filter-chips" role="group" aria-label="Filter tickets">
              {FILTERS.map((f) => {
                const n = tickets.filter(f.test).length;
                return (
                  <button key={f.id} className={`chip${filters.has(f.id) ? " on" : ""}`} aria-pressed={filters.has(f.id)} onClick={() => toggleFilter(f.id)}>
                    {f.label}{n > 0 && <span className="chip-count">{n}</span>}
                  </button>
                );
              })}
            </div>
            {filtering && (
              <span className="muted small" aria-live="polite">
                {shownTickets.length} of {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
                {" · "}<button className="link-btn small" onClick={() => { setQuery(""); setFilters(new Set()); }}>Clear all</button>
              </span>
            )}
          </div>
          <Board tickets={shownTickets} filtered={filtering} onOpen={(id) => openTicket(id)} onMove={move} onAdd={() => setNewTicket(true)} restartPending={restart.pending} />
        </>
      )}

      {dockOpen && profile && (
        <Suspense fallback={null}>
          <Dock profile={profile} pty={health?.pty ?? true} onClose={() => setDockOpen(false)} command={dockCommand}
            onCommandSent={() => setDockCommand(null)} tabRequest={dockTab} onTabChange={setDockShown} onOpenTicket={(id) => openTicket(id)} />
        </Suspense>
      )}

      {connections && (
        <ConnectionsDialog state={mcp} onClose={() => setConnections(false)}
          onRunInTerminal={profile && health?.pty !== false ? (cmd) => { setConnections(false); runInTerminal(cmd); } : undefined} />
      )}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
      {bugReport && <BugReportDialog onClose={() => setBugReport(false)} />}
      {boardSwitcher && profiles && (
        <BoardSwitcher profiles={profiles} current={slug} needYou={perBoard} onClose={() => setBoardSwitcher(false)}
          onPick={(s) => { setBoardSwitcher(false); switchBoard(s); }} />
      )}
      {switcher && profile && (
        <QuickSwitcher tickets={tickets} onClose={() => setSwitcher(false)} onPick={(id) => { setSwitcher(false); openTicket(id); }} />
      )}
      {schedulesOpen && profile && (
        <SchedulesDialog profile={profile} schedules={schedules} tickets={tickets} onClose={() => setSchedulesOpen(false)}
          onOpenTicket={(id) => { setSchedulesOpen(false); openTicket(id); }} />
      )}
      {open && profile && <TicketDrawer key={open.id} profile={profile} ticket={open} tickets={tickets} onOpenTicket={openTicket} onClose={closeTicket}
        nav={{ prev: prevId, next: nextId, go: stepTicket }} slideIn={!stepped.current} />}
      {profileDialog && (
        <ProfileDialog
          profile={profileDialog === "edit" ? profile : null}
          onClose={() => setProfileDialog(null)}
          onSaved={(p) => {
            setProfileDialog(null);
            loadProfiles().then(() => setSlug(p.slug));
          }}
          onDeleted={() => {
            setProfileDialog(null);
            setSlug(null);
            loadProfiles();
          }}
        />
      )}
      {newTicket && profile && (
        <NewTicketDialog
          slug={profile.slug}
          folder={profile.path}
          onClose={() => setNewTicket(false)}
          onCreate={async (input) => {
            const t = await api.createTicket(profile.slug, input);
            setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
            setNewTicket(false);
            // Planning starts the interview immediately: open the ticket so the questions are in view.
            if (t.status === "planning") openTicket(t.id);
          }}
        />
      )}
      <Toaster />
    </div>
  );
}
