import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeProject, type Profile } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";

const MODELS = ["opus", "sonnet", "haiku"];
const DEFAULT_MAX_PARALLEL = 5;

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

export function ProfileDialog({ profile, onClose, onSaved, onDeleted }: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: (p: Profile) => void;
  onDeleted: () => void;
}) {
  const isNew = !profile;
  const [name, setName] = useState(profile?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!isNew);
  const [path, setPath] = useState(profile?.path ?? "");
  const [maxParallelText, setMaxParallelText] = useState(String(profile?.maxParallel ?? DEFAULT_MAX_PARALLEL));
  const maxParallel = Number(maxParallelText);
  const maxParallelError = /^\d+$/.test(maxParallelText.trim()) && maxParallel >= 1 && maxParallel <= 20 ? null : "A whole number from 1 to 20";
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(profile?.model ?? "");
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [recent, setRecent] = useState<ClaudeProject[] | null>(null);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ticketCount, setTicketCount] = useState<number | null>(null);

  useEffect(() => {
    api.claudeDefaults().then((d) => setClaudeModel(d.model)).catch(() => {});
    if (isNew) api.claudeProjects().then(setRecent).catch(() => setRecent([]));
    else api.tickets(profile!.slug).then((ts) => setTicketCount(ts.length)).catch(() => {});
  }, [isNew]);

  const choose = (p: string) => {
    setPath(p);
    setErr(null);
    if (!nameTouched) setName(folderName(p));
  };

  const browse = async () => {
    setPicking(true);
    try {
      const r = await api.pickFolder();
      if (r.path) choose(r.path);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPicking(false);
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = recent ?? [];
    return q ? list.filter((p) => p.path.toLowerCase().includes(q)) : list;
  }, [recent, filter]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || maxParallelError) return;
    setSaving(true);
    try {
      const p = profile
        ? await api.updateProfile(profile.slug, { name, path, maxParallel, model: model || null })
        : await api.createProfile({ name, path, maxParallel, model: model || undefined });
      onSaved(p);
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!profile) return;
    await api.deleteProfile(profile.slug);
    onDeleted();
  };

  const customModel = model && !MODELS.includes(model) ? model : null;

  return (
    <Modal title={profile ? `Profile: ${profile.name}` : "New profile"} onClose={onClose} wide={isNew}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <div className="field-label">Folder</div>
          {isNew && (
            <div className="picker">
              <div className="picker-head">
                <span className="muted small">Recent Claude Code folders</span>
                {recent && recent.length > 6 && (
                  <input className="picker-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" />
                )}
              </div>
              <div className="picker-list" role="listbox" aria-label="Recent folders">
                {recent === null && <div className="picker-empty">Loading…</div>}
                {recent !== null && shown.length === 0 && (
                  <div className="picker-empty">{recent.length ? "No match." : "No Claude Code sessions found. Browse for a folder below."}</div>
                )}
                {shown.map((p) => (
                  <button
                    type="button"
                    key={p.path}
                    role="option"
                    aria-selected={path === p.path}
                    className={`picker-row ${path === p.path ? "selected" : ""}`}
                    onClick={() => choose(p.path)}
                  >
                    <span className="picker-name">{p.name}</span>
                    <span className="picker-path">{p.path}</span>
                    <span className="picker-meta">
                      {p.hasProfile && <span className="badge stopped">has board</span>}
                      {p.lastUsed && <span className="muted small" title={new Date(p.lastUsed).toLocaleString()}>{timeAgo(p.lastUsed)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="path-row">
            <input value={path} onChange={(e) => choose(e.target.value)} placeholder="/Users/you/dev/my-app" spellCheck={false}
              aria-label="Folder path" />
            <button type="button" className="btn" onClick={browse} disabled={picking}>{picking ? "Choosing…" : "Browse…"}</button>
          </div>
          <span className="muted small">Git repo: each ticket gets its own worktree + branch and a PR. Plain folder: Claude works in place.</span>
        </div>

        <label>
          Name
          <input value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="My app" />
        </label>

        <div className="row two">
          <label>
            Max parallel runs
            <input type="number" min={1} max={20} step={1} value={maxParallelText} onChange={(e) => setMaxParallelText(e.target.value)}
              aria-invalid={!!maxParallelError} aria-describedby={maxParallelError ? "max-parallel-error" : undefined} />
            {maxParallelError && <span id="max-parallel-error" className="field-error">{maxParallelError}</span>}
          </label>
          <label>
            Model
            <Select
              ariaLabel="Model"
              value={model}
              onChange={setModel}
              options={[
                { value: "", label: claudeModel ? `Claude default (${claudeModel})` : "Claude default", hint: "follows ~/.claude/settings.json" },
                ...MODELS.map((m) => ({ value: m, label: m })),
                ...(customModel ? [{ value: customModel, label: customModel }] : []),
              ]}
            />
          </label>
        </div>

        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          {profile && (
            <button type="button" className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Delete profile</button>
          )}
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving || !name.trim() || !path.trim() || !!maxParallelError}>
            {saving ? (profile ? "Saving…" : "Creating…") : profile ? "Save" : "Create board"}
          </button>
        </div>
      </form>
      {confirmDelete && profile && (
        <ConfirmDialog
          title={`Delete board "${profile.name}"?`}
          confirmLabel="Delete board"
          busyLabel="Deleting…"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        >
          <p>
            Removes {ticketCount === null ? "all" : ticketCount} ticket{ticketCount === 1 ? "" : "s"} with their comments and transcripts
            from <code>~/.claude-kanban</code>. This cannot be undone.
          </p>
          <p className="muted">Your folder <code>{profile.path}</code>, git branches and Claude sessions are not touched.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
