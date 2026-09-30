import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onReconnect, subscribe, type InboxItem, type McpState, type Profile, type Status, type Ticket } from "./api";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { Inbox } from "./Inbox";
import { Board } from "./Board";
import { NewTicketDialog } from "./NewTicketDialog";
import { ProfileDialog } from "./ProfileDialog";
import { Select } from "./Select";
import { TicketDrawer } from "./TicketDrawer";

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
  const [health, setHealth] = useState<{ claude: boolean; git: boolean; gh: boolean } | null>(null);
  const [openId, setOpenId] = useState<string | null>(parseHash().ticket);
  // True when the open ticket was pushed onto browser history by us, so closing can go Back.
  const pushedOpen = useRef(false);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileDialog, setProfileDialog] = useState<"new" | "edit" | null>(null);
  const [newTicket, setNewTicket] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [connections, setConnections] = useState(false);
  const [version, setVersion] = useState<{ version: string; latest: string | null; updateAvailable: boolean } | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await api.profiles();
    setProfiles(ps);
    setSlug((cur) => (cur && ps.some((p) => p.slug === cur) ? cur : ps[0]?.slug ?? null));
  }, []);

  const loadInbox = useCallback(() => api.inbox().then(setInbox).catch(() => {}), []);
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
    api.health().then(setHealth).catch(() => {});
    api.version().then(setVersion).catch(() => {});
    api.mcp().then(setMcp).catch(() => {});
  }, [loadProfiles, loadInbox]);

  // Browser Back/Forward and pasted links drive the open board and ticket.
  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      if (h.slug) setSlug(h.slug);
      setOpenId(h.ticket);
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
    location.hash = hashFor(board, id);
  }, [slug]);

  const closeTicket = useCallback(() => {
    if (pushedOpen.current) history.back();
    else {
      history.replaceState(null, "", hashFor(slug));
      setOpenId(null);
    }
  }, [slug]);

  // After the daemon restarts or the laptop wakes, events were missed: reload everything.
  useEffect(() => onReconnect(() => {
    loadProfiles().catch(() => {});
    loadInbox();
    api.mcp().then(setMcp).catch(() => {});
    if (slug) api.tickets(slug).then(setTickets).catch(() => {});
  }), [slug, loadProfiles, loadInbox]);

  const needYou = inbox.length;
  useEffect(() => {
    document.title = needYou ? `(${needYou}) Claude Kanban` : "Claude Kanban";
  }, [needYou]);

  // Shortcuts: N new ticket, / search. Esc is handled by the panel and dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (openId || profileDialog || newTicket || connections || document.querySelector(".overlay")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (slug) setNewTicket("backlog");
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, profileDialog, newTicket, connections, slug]);

  useEffect(() => {
    if (!slug) return;
    try {
      localStorage.setItem(LAST_PROFILE, slug);
    } catch {}
    setTickets([]);
    api.tickets(slug).then(setTickets).catch((e) => setError(e.message));
  }, [slug]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "mcp.updated") {
          setMcp(e.state);
          return;
        }
        if (e.type === "profile.updated") {
          loadProfiles().catch(() => {});
          refreshInboxSoon();
          return;
        }
        if (e.type === "ticket.updated" || e.type === "ticket.deleted" || e.type === "session.updated") refreshInboxSoon();
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
    [slug, loadProfiles, refreshInboxSoon],
  );

  const profile = useMemo(() => profiles?.find((p) => p.slug === slug) ?? null, [profiles, slug]);
  const open = tickets.find((t) => t.id === openId) ?? null;
  const q = query.trim().toLowerCase();
  const shownTickets = q ? tickets.filter((t) => `${t.title}\n${t.body}`.toLowerCase().includes(q)) : tickets;
  const perBoard = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inbox) m.set(i.profile, (m.get(i.profile) ?? 0) + 1);
    return m;
  }, [inbox]);

  const move = async (id: string, status: Status, order: number) => {
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, order } : t)));
    try {
      await api.updateTicket(slug!, id, { status, order });
    } catch (e: any) {
      setError(e.message);
      api.tickets(slug!).then(setTickets);
    }
  };

  const mcpAttention = mcp?.servers.filter((s) => s.attention).length ?? 0;
  const missing = health ? (["claude", "git", "gh"] as const).filter((k) => !health[k]) : [];
  const running = tickets.filter((t) => t.status === "in_progress").length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          Claude Kanban
        </div>
        {profiles && profiles.length > 0 && (
          <Select
            className="profile-select"
            ariaLabel="Profile"
            value={slug ?? ""}
            onChange={setSlug}
            options={profiles.map((p) => ({
              value: p.slug,
              label: perBoard.get(p.slug) ? <>{p.name} <span className="need-chip">{perBoard.get(p.slug)} need you</span></> : p.name,
              hint: p.path.replace(/^\/Users\/[^/]+/, "~"),
            }))}
            renderValue={() => profile?.name}
            footer={[{ label: "New profile…", onSelect: () => setProfileDialog("new") }]}
          />
        )}
        {profile && (
          <>
            <span className="profile-path" title={profile.path}>
              {profile.path}
            </span>
            <span className="pill">
              {running}/{profile.maxParallel} running
            </span>
            <button className="btn ghost" onClick={() => setProfileDialog("edit")}>
              Settings
            </button>
          </>
        )}
        <div className="spacer" />
        {profile && (
          <div className="search">
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tickets  /"
              aria-label="Search tickets on this board"
              onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); } }} />
            {q && <span className="muted small">{shownTickets.length} match{shownTickets.length === 1 ? "" : "es"}</span>}
          </div>
        )}
        <Inbox items={inbox} onPick={(i) => {
          if (i.profile !== slug) setSlug(i.profile);
          openTicket(i.id, i.profile);
        }} />
        <button className="btn ghost connections-btn" onClick={() => setConnections(true)}
          title={mcpAttention ? `${mcpAttention} MCP server${mcpAttention === 1 ? "" : "s"} failed or need you to log in again` : "Claude Code MCP servers"}>
          Connections
          {mcpAttention > 0 && <span className="need-chip">{mcpAttention}</span>}
        </button>
        {version && version.version !== "dev" && <span className="muted small">v{version.version}</span>}
        {profile && (
          <button className="btn primary" onClick={() => setNewTicket("backlog")}>
            New ticket
          </button>
        )}
      </header>

      {version?.updateAvailable && (
        <div className="banner info">
          Claude Kanban v{version.latest} is available (you have v{version.version}). Run <code>ckanban update</code> in a terminal.
        </div>
      )}
      {missing.length > 0 && (
        <div className="banner warn">
          Not found on PATH: <b>{missing.join(", ")}</b>. {missing.includes("claude") ? "Tickets cannot run." : "PR features limited."}
        </div>
      )}
      {profile && profile.pathExists === false && (
        <div className="banner warn">
          Profile folder <code>{profile.path}</code> does not exist. Tickets will not be picked up.
        </div>
      )}
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      {profiles === null ? (
        <div className="empty">Loading…</div>
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
          {q && shownTickets.length === 0 && <div className="banner info">No tickets match "{query}". <button className="link-btn" onClick={() => setQuery("")}>Clear search</button></div>}
          <Board tickets={shownTickets} onOpen={(id) => openTicket(id)} onMove={move} onAdd={setNewTicket} />
        </>
      )}

      {connections && <ConnectionsDialog state={mcp} onClose={() => setConnections(false)} />}
      {open && profile && <TicketDrawer key={open.id} profile={profile} ticket={open} onClose={closeTicket} />}
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
          initialStatus={newTicket}
          onClose={() => setNewTicket(null)}
          onCreate={async (input) => {
            const t = await api.createTicket(profile.slug, input);
            setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
            setNewTicket(null);
            // Planning starts the interview immediately: open the ticket so the questions are in view.
            if (t.status === "planning") openTicket(t.id);
          }}
        />
      )}
    </div>
  );
}
