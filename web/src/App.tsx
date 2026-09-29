import { useCallback, useEffect, useMemo, useState } from "react";
import { api, subscribe, type Profile, type Status, type Ticket } from "./api";
import { Board } from "./Board";
import { NewTicketDialog } from "./NewTicketDialog";
import { ProfileDialog } from "./ProfileDialog";
import { Select } from "./Select";
import { TicketDrawer } from "./TicketDrawer";

const LAST_PROFILE = "ckanban.profile";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [slug, setSlug] = useState<string | null>(readLast());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [health, setHealth] = useState<{ claude: boolean; git: boolean; gh: boolean } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [profileDialog, setProfileDialog] = useState<"new" | "edit" | null>(null);
  const [newTicket, setNewTicket] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await api.profiles();
    setProfiles(ps);
    setSlug((cur) => (cur && ps.some((p) => p.slug === cur) ? cur : ps[0]?.slug ?? null));
  }, []);

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    api.health().then(setHealth).catch(() => {});
  }, [loadProfiles]);

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
        if (e.type === "profile.updated") {
          loadProfiles().catch(() => {});
          return;
        }
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
    [slug, loadProfiles],
  );

  const profile = useMemo(() => profiles?.find((p) => p.slug === slug) ?? null, [profiles, slug]);
  const open = tickets.find((t) => t.id === openId) ?? null;

  const move = async (id: string, status: Status, order: number) => {
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, order } : t)));
    try {
      await api.updateTicket(slug!, id, { status, order });
    } catch (e: any) {
      setError(e.message);
      api.tickets(slug!).then(setTickets);
    }
  };

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
            options={profiles.map((p) => ({ value: p.slug, label: p.name, hint: p.path.replace(/^\/Users\/[^/]+/, "~") }))}
            renderValue={(o) => o?.label}
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
          <button className="btn primary" onClick={() => setNewTicket("backlog")}>
            New ticket
          </button>
        )}
      </header>

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
        <Board tickets={tickets} onOpen={setOpenId} onMove={move} onAdd={setNewTicket} />
      )}

      {open && profile && <TicketDrawer key={open.id} profile={profile} ticket={open} onClose={() => setOpenId(null)} onError={setError} />}
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
          }}
        />
      )}
    </div>
  );
}
