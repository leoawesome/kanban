import { useState } from "react";
import { api, type Profile } from "./api";
import { Modal } from "./Modal";

export function ProfileDialog({ profile, onClose, onSaved, onDeleted }: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: (p: Profile) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [path, setPath] = useState(profile?.path ?? "");
  const [baseBranch, setBaseBranch] = useState(profile?.baseBranch ?? "");
  const [maxParallel, setMaxParallel] = useState(profile?.maxParallel ?? 1);
  const [model, setModel] = useState(profile?.model ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const input = { name, path, baseBranch: baseBranch || undefined, maxParallel, model: model || undefined };
      const p = profile ? await api.updateProfile(profile.slug, { ...input, model: model || null }) : await api.createProfile(input);
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

  return (
    <Modal title={profile ? `Profile: ${profile.name}` : "New profile"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My app" />
        </label>
        <label>
          Folder path
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/dev/my-app" spellCheck={false} />
          <span className="muted small">Git repo: each ticket gets its own worktree + branch. Plain folder: Claude works in place.</span>
        </label>
        <div className="row">
          <label>
            Base branch
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="auto-detect" spellCheck={false} />
          </label>
          <label>
            Max parallel
            <input type="number" min={1} max={10} value={maxParallel} onChange={(e) => setMaxParallel(Number(e.target.value) || 1)} />
          </label>
          <label>
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" spellCheck={false} />
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
          <button type="submit" className="btn primary" disabled={!name.trim() || !path.trim()}>{profile ? "Save" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
