import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type HuddleNote, type HuddleNotes, type HuddlePreset } from "./api";
import { Select } from "./Select";

const MODELS = ["opus", "sonnet", "haiku"];
type Draft = Omit<HuddlePreset, "source">;
const EMPTY: Draft = { name: "", role: "", prompt: "", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared" };

const SOURCE: Record<HuddlePreset["source"], string> = { builtin: "built-in", override: "changed", board: "this board" };

/** Enter in these inputs must not submit the surrounding profile form. */
const noSubmit = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
};

/** Board settings: the huddle role presets (built-ins, overridden or not, and the board's own). Saves right away. */
export function HuddleRoles({ slug }: { slug: string }) {
  const [presets, setPresets] = useState<HuddlePreset[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The role whose notes are open ("_all": every role), or null for the list. */
  const [notesOf, setNotesOf] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ notes: HuddleNotes; cap: number } | null>(null);

  const load = () => api.huddlePresets(slug).then(setPresets).catch((e) => setErr((e as Error).message));
  const loadNotes = () => api.huddleNotes(slug).then(setNotes).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    loadNotes();
  }, [slug]);
  const noteCount = (role: string) => (notes?.notes[role]?.general.length ?? 0) + (notes?.notes[role]?.repo.length ?? 0);

  const edit = (p: HuddlePreset | null) => {
    setErr(null);
    setIsNew(!p);
    if (!p) return setDraft({ ...EMPTY });
    const { source: _s, ...d } = p;
    setDraft(d);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveHuddlePreset(slug, draft);
      setDraft(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: HuddlePreset) => {
    setBusy(true);
    setErr(null);
    try {
      setPresets((await api.deleteHuddlePreset(slug, p.name)).presets);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <>
      <div className="form-section">
        <span>Huddle roles</span>
        {!draft && !notesOf && <button type="button" className="btn small ghost link" onClick={() => edit(null)}>+ Add role</button>}
      </div>
      <span className="muted small">Presets for huddle participants. Claude can add them from chat too. Changes save right away.</span>
      {presets === null && !err && <span className="muted small">Loading…</span>}
      {presets && notesOf && (
        <RoleNotes slug={slug} roles={presets.filter((p) => p.name !== "main")} role={notesOf} onRole={setNotesOf} data={notes}
          onChange={(role, scope, list) => setNotes((n) => n && { ...n, notes: { ...n.notes, [role]: { ...(n.notes[role] ?? { general: [], repo: [] }), [scope]: list } } })}
          onClose={() => setNotesOf(null)} onError={setErr} />
      )}
      {presets && !draft && !notesOf && (
        <div className="hp-list">
          {presets.map((p) => (
            <div key={p.name} className="hp-row">
              <div className="hp-main">
                <span className="hp-name mono">{p.name}</span>
                <span className="hp-role">{p.role}</span>
                <span className={`hp-src ${p.source}`}>{SOURCE[p.source]}</span>
              </div>
              <span className="hp-meta muted small">
                {[p.mode, p.workspace === "own" ? "own worktree" : "shared", p.lead && "lead", p.canEdit && p.workspace === "own" && "edits", p.model].filter(Boolean).join(" · ")}
              </span>
              <div className="hp-actions">
                {p.name !== "main" && (
                  <button type="button" className="btn small ghost" onClick={() => { setErr(null); setNotesOf(p.name); }} disabled={busy}
                    title="Lessons from past huddles, added to every new agent of this role">Notes{noteCount(p.name) ? ` (${noteCount(p.name)})` : ""}</button>
                )}
                <button type="button" className="btn small ghost" onClick={() => edit(p)} disabled={busy}>Edit</button>
                {p.source === "override" && <button type="button" className="btn small ghost" onClick={() => remove(p)} disabled={busy} title="Back to the built-in">Reset</button>}
                {p.source === "board" && <button type="button" className="btn small ghost danger" onClick={() => remove(p)} disabled={busy}>Delete</button>}
              </div>
            </div>
          ))}
          <div className="hp-row hp-all">
            <div className="hp-main">
              <span className="hp-name">All roles</span>
              <span className="hp-role">notes every huddle agent gets</span>
            </div>
            <div className="hp-actions">
              <button type="button" className="btn small ghost" onClick={() => { setErr(null); setNotesOf(ALL_ROLES); }} disabled={busy}>
                Notes{noteCount(ALL_ROLES) ? ` (${noteCount(ALL_ROLES)})` : ""}
              </button>
            </div>
          </div>
        </div>
      )}
      {draft && (
        <div className="hp-edit" onKeyDown={noSubmit}>
          <div className="row two">
            <label>
              Name
              <input className="mono" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!isNew} placeholder="a11y" spellCheck={false} autoFocus={isNew} />
            </label>
            <label>
              Role label
              <input value={draft.role} onChange={(e) => set({ role: e.target.value })} placeholder="Accessibility tester" />
            </label>
          </div>
          <label>
            Prompt
            <textarea rows={4} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="What this role does in a huddle: what to look at, how to report." />
          </label>
          {draft.name === "main" ? (
            <span className="muted small">The coordinator is the ticket's own session (@main): only its label, mode and prompt apply.</span>
          ) : (
            <div className="row two">
              <label>
                Model
                <Select ariaLabel="Model" value={draft.model ?? ""} onChange={(v) => set({ model: v || null })}
                  options={[{ value: "", label: "Board default" }, ...MODELS.map((m) => ({ value: m, label: m })),
                    ...(draft.model && !MODELS.includes(draft.model) ? [{ value: draft.model, label: draft.model }] : [])]} />
              </label>
              <label>
                Workspace
                <Select ariaLabel="Workspace" value={draft.workspace} onChange={(v) => set({ workspace: v, canEdit: v === "own" ? draft.canEdit : false })}
                  options={[{ value: "shared", label: "Shared", hint: "read-only in the ticket's worktree" }, { value: "own", label: "Own worktree", hint: "its own branch" }]} />
              </label>
            </div>
          )}
          <div className="row two">
            <label>
              Mode
              <Select ariaLabel="Mode" value={draft.mode} onChange={(v) => set({ mode: v })}
                options={[{ value: "tagged", label: "Tagged", hint: "sleeps until @mentioned" }, { value: "monitor", label: "Monitor", hint: "gets every message" }]} />
            </label>
            {draft.name !== "main" && (
              <div className="hp-checks">
                <label className="check-row"><input type="checkbox" checked={draft.lead} onChange={(e) => set({ lead: e.target.checked })} /> Lead</label>
                <label className="check-row" title={draft.workspace === "own" ? "" : "Only in its own worktree"}>
                  <input type="checkbox" checked={draft.canEdit} disabled={draft.workspace !== "own"} onChange={(e) => set({ canEdit: e.target.checked })} /> Can edit code
                </label>
              </div>
            )}
          </div>
          <div className="form-actions">
            <div className="spacer" />
            <button type="button" className="btn ghost small" onClick={() => { setDraft(null); setErr(null); }}>Cancel</button>
            <button type="button" className="btn primary small" onClick={save} disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>
              {busy ? "Saving…" : isNew ? "Add role" : "Save role"}
            </button>
          </div>
        </div>
      )}
      {err && <div className="form-error">{err}</div>}
    </>
  );
}

const ALL_ROLES = "_all";
const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const noteSource = (n: HuddleNote) => [n.by === "you" ? "by you" : `from @${n.by}`, n.date && shortDate(n.date)].filter(Boolean).join(", ");

/**
 * A role's notes: lessons the user saved from past huddles (or wrote here), added to every new agent of the role.
 * General notes apply in every repo, This-repo notes only on this board. Past the cap the oldest stop going into
 * instructions; they stay listed.
 */
function RoleNotes({ slug, roles, role, onRole, data, onChange, onClose, onError }: {
  slug: string;
  roles: HuddlePreset[];
  role: string;
  onRole: (r: string) => void;
  data: { notes: HuddleNotes; cap: number } | null;
  onChange: (role: string, scope: "general" | "repo", list: HuddleNote[]) => void;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const label = role === ALL_ROLES ? "All roles" : roles.find((p) => p.name === role)?.role ?? role;
  const cap = data?.cap ?? 30;
  const cur = data?.notes[role] ?? { general: [], repo: [] };
  return (
    <div className="hn" onKeyDown={noSubmit}>
      <div className="hn-roles" role="tablist" aria-label="Role">
        {[...roles.map((p) => ({ name: p.name, label: p.role })), { name: ALL_ROLES, label: "All roles" }].map((r) => (
          <button key={r.name} type="button" role="tab" aria-selected={r.name === role} className={r.name === role ? "on" : undefined} onClick={() => onRole(r.name)}>
            {r.label}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={onClose}>Done</button>
      </div>
      <div className="hn-intro small">
        <b>{label}</b> · {role === ALL_ROLES ? "added to every new huddle agent's instructions" : `added to every new ${label} agent's instructions (plus "All roles" notes)`}
      </div>
      {!data ? (
        <span className="muted small">Loading…</span>
      ) : (
        <div className="hn-cols">
          {(["general", "repo"] as const).map((scope) => (
            <NotesColumn key={`${role}/${scope}`} title={scope === "general" ? "General · all repos" : `This repo · ${slug}`} notes={cur[scope]} cap={cap}
              onSave={async (list) => {
                onError(null);
                try {
                  onChange(role, scope, await api.setHuddleNotes(slug, role, scope, list));
                  return true;
                } catch (e) {
                  onError((e as Error).message);
                  return false;
                }
              }} />
          ))}
        </div>
      )}
      <span className="muted small">Past {cap} lines per column the oldest notes stop going into instructions; they stay listed here.</span>
    </div>
  );
}

function NotesColumn({ title, notes, cap, onSave }: { title: string; notes: HuddleNote[]; cap: number; onSave: (list: HuddleNote[]) => Promise<boolean> }) {
  /** The line being edited (index; -1: a new one at the top) and its text. */
  const [edit, setEdit] = useState<{ at: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (list: HuddleNote[]) => {
    setBusy(true);
    const ok = await onSave(list);
    setBusy(false);
    if (ok) setEdit(null);
  };
  const commit = () => {
    if (!edit) return;
    const text = edit.text.trim();
    if (!text) return setEdit(null);
    if (edit.at < 0) return save([{ text, by: "you", date: today(), huddle: null }, ...notes]);
    if (text === notes[edit.at].text) return setEdit(null);
    save(notes.map((n, i) => (i === edit.at ? { ...n, text } : n)));
  };
  const input = (
    <input value={edit?.text ?? ""} autoFocus disabled={busy} maxLength={400} aria-label="Note" placeholder="A rule, e.g. Give every bug a repro command."
      onChange={(e) => setEdit((x) => x && { ...x, text: e.target.value })} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.stopPropagation(); setEdit(null); }
      }} />
  );
  return (
    <div className="hn-col">
      <div className="hn-col-head">
        <h4>{title}</h4>
        <span className={`hn-cap${notes.length > cap ? " over" : ""}`}>{notes.length} / {cap} lines</span>
        <span className="spacer" />
        {!edit && <button type="button" className="btn small ghost link" onClick={() => setEdit({ at: -1, text: "" })} disabled={busy}>+ Add note</button>}
      </div>
      {edit?.at === -1 && <div className="hn-edit">{input}</div>}
      {!notes.length && edit?.at !== -1 && <span className="muted small">No notes yet.</span>}
      <ul>
        {notes.map((n, i) => (
          <li key={i} className={i >= cap ? "past-cap" : undefined} title={i >= cap ? "Past the cap: not added to instructions" : undefined}>
            {edit?.at === i ? input : (
              <>
                <span className="hn-text">{n.text}</span> <span className="hn-src">{noteSource(n)}</span>
                <span className="hn-acts">
                  <button type="button" className="link-btn" onClick={() => setEdit({ at: i, text: n.text })} disabled={busy || !!edit}>edit</button>
                  <button type="button" className="link-btn danger" onClick={() => save(notes.filter((_, j) => j !== i))} disabled={busy || !!edit}
                    aria-label={`Delete note: ${n.text}`}>delete</button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
