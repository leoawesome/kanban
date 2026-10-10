import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type HuddleTemplate } from "./api";
import { RosterEditor, rosterDraft, templateRules, usePresets, type RosterDraft } from "./HuddleRoster";
import { DEFAULT_BUDGET } from "./huddleText";

type Draft = { name: string; label: string; description: string; rounds: string; budget: string; report: string; roster: RosterDraft };

const SOURCE: Record<HuddleTemplate["source"], string> = { builtin: "built-in", override: "changed", board: "this board" };

/** Enter in these inputs must not submit the surrounding profile form. */
const noSubmit = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
};

const toDraft = (t: HuddleTemplate | null): Draft => ({
  name: t?.name ?? "", label: t?.label ?? "", description: t?.description ?? "",
  rounds: t?.rounds ? String(t.rounds) : "", budget: String(t?.maxCostUsd ?? DEFAULT_BUDGET), report: t?.report ?? "",
  roster: rosterDraft(t?.roster ?? [{ preset: "reviewer" }]),
});

/** Board settings: whole-huddle templates (a roster plus rounds, budget and report format). Saves right away. */
export function HuddleTemplates({ slug }: { slug: string }) {
  const presets = usePresets(slug);
  const [templates, setTemplates] = useState<HuddleTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.huddleTemplates(slug).then(setTemplates).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, [slug]);

  const edit = (t: HuddleTemplate | null) => {
    setErr(null);
    setIsNew(!t);
    setDraft(toDraft(t));
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveHuddleTemplate(slug, {
        name: draft.name, label: draft.label, description: draft.description, report: draft.report,
        rounds: draft.rounds.trim() ? Number(draft.rounds) : null,
        maxCostUsd: draft.budget.trim() ? Number(draft.budget) : null,
        roster: draft.roster.rows.map(({ key: _k, ...e }) => ({ ...e, focus: e.focus?.trim() || undefined })),
      });
      setDraft(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: HuddleTemplate) => {
    setBusy(true);
    setErr(null);
    try {
      setTemplates((await api.deleteHuddleTemplate(slug, t.name)).templates);
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
        <span>Huddle templates</span>
        {!draft && <button type="button" className="btn small ghost link" onClick={() => edit(null)}>+ Add template</button>}
      </div>
      <span className="muted small">Whole huddles to start from: a roster plus its rules. The rules become the huddle's pinned brief. Changes save right away.</span>
      {templates === null && !err && <span className="muted small">Loading…</span>}
      {templates && !draft && (
        <div className="hp-list">
          {templates.map((t) => (
            <div key={t.name} className="hp-row">
              <div className="hp-main">
                <span className="hp-name mono">{t.name}</span>
                <span className="hp-role">{t.label}</span>
                <span className={`hp-src ${t.source}`}>{SOURCE[t.source]}</span>
              </div>
              <span className="hp-meta muted small" title={t.description}>
                {[t.roster.map((e) => e.handle ?? e.preset ?? e.role).join(", "), templateRules(t)].filter(Boolean).join(" · ")}
              </span>
              <div className="hp-actions">
                <button type="button" className="btn small ghost" onClick={() => edit(t)} disabled={busy}>Edit</button>
                {t.source === "override" && <button type="button" className="btn small ghost" onClick={() => remove(t)} disabled={busy} title="Back to the built-in">Reset</button>}
                {t.source === "board" && <button type="button" className="btn small ghost danger" onClick={() => remove(t)} disabled={busy}>Delete</button>}
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
              <input className="mono" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!isNew} placeholder="design-review" spellCheck={false} autoFocus={isNew} />
            </label>
            <label>
              Label
              <input value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="Design review" />
            </label>
          </div>
          <label>
            What it's for
            <input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Critics review a feature from several angles; a facilitator ranks the findings." />
          </label>
          <div className="row two">
            <label>
              Rounds
              <input type="number" min={1} max={20} value={draft.rounds} onChange={(e) => set({ rounds: e.target.value })} placeholder="no limit" />
            </label>
            <label>
              Budget ($)
              <input type="number" min={1} step={1} value={draft.budget} onChange={(e) => set({ budget: e.target.value })} />
            </label>
          </div>
          <label>
            Report format
            <textarea rows={2} value={draft.report} onChange={(e) => set({ report: e.target.value })}
              placeholder="How participants report, e.g. one finding per line: [MUST|SHOULD|COULD] file:line - problem - fix. Report to @facilitator." />
          </label>
          <div className="hp-roster">
            <span className="small">Roster</span>
            <RosterEditor presets={presets} draft={draft.roster} setDraft={(roster) => set({ roster })} tickets={[]} hostId="" hideMain disabled={busy} />
          </div>
          <div className="form-actions">
            <div className="spacer" />
            <button type="button" className="btn ghost small" onClick={() => { setDraft(null); setErr(null); }}>Cancel</button>
            <button type="button" className="btn primary small" onClick={save}
              disabled={busy || !draft.name.trim() || !draft.roster.rows.length || draft.roster.rows.some((r) => !r.preset && !r.role?.trim())}>
              {busy ? "Saving…" : isNew ? "Add template" : "Save template"}
            </button>
          </div>
        </div>
      )}
      {err && <div className="form-error">{err}</div>}
    </>
  );
}
