import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type HuddlePreset } from "./api";
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

  const load = () => api.huddlePresets(slug).then(setPresets).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, [slug]);

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
        {!draft && <button type="button" className="btn small ghost link" onClick={() => edit(null)}>+ Add role</button>}
      </div>
      <span className="muted small">Presets for huddle participants. Claude can add them from chat too. Changes save right away.</span>
      {presets === null && !err && <span className="muted small">Loading…</span>}
      {presets && !draft && (
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
                <button type="button" className="btn small ghost" onClick={() => edit(p)} disabled={busy}>Edit</button>
                {p.source === "override" && <button type="button" className="btn small ghost" onClick={() => remove(p)} disabled={busy} title="Back to the built-in">Reset</button>}
                {p.source === "board" && <button type="button" className="btn small ghost danger" onClick={() => remove(p)} disabled={busy}>Delete</button>}
              </div>
            </div>
          ))}
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
