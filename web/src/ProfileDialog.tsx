import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeProject, type Profile } from "./api";
import { Modal } from "./Modal";
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
  const [maxParallel, setMaxParallel] = useState(profile?.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const [model, setModel] = useState(profile?.model ?? "");
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [recent, setRecent] = useState<ClaudeProject[] | null>(null);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api.claudeDefaults().then((d) => setClaudeModel(d.model)).catch(() => {});
    if (isNew) api.claudeProjects().then(setRecent).catch(() => setRecent([]));
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
    try {
      const p = profile
        ? await api.updateProfile(profile.slug, { name, path, maxParallel, model: model || null })
        : await api.createProfile({ name, path, maxParallel, model: model || undefined });
      onSaved(p);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const remove = async () => {
    if (!profile) return;
    try {
      await api.deleteProfile(profile.slug);
      onDeleted();
    } catch (e: any) {
      setErr(e.message);
    }
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
                    onDoubleClick={() => choose(p.path)}
                  >
                    <span className="picker-name">{p.name}</span>
                    <span className="picker-path">{p.path}</span>
                    <span className="picker-meta">
                      {p.hasProfile && <span className="badge stopped">has board</span>}
                      {p.lastUsed && <span className="muted small">{timeAgo(p.lastUsed)}</span>}
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
            <input type="number" min={1} max={20} value={maxParallel} onChange={(e) => setMaxParallel(Number(e.target.value) || 1)} />
          </label>
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Claude default{claudeModel ? ` (${claudeModel})` : ""}</option>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              {customModel && <option value={customModel}>{customModel}</option>}
            </select>
          </label>
        </div>

        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          {profile && (confirmDelete ? (
            <button type="button" className="btn danger" onClick={remove}>Really delete board data?</button>
          ) : (
            <button type="button" className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>Delete profile</button>
          ))}
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !path.trim()}>{profile ? "Save" : "Create board"}</button>
        </div>
      </form>
    </Modal>
  );
}
