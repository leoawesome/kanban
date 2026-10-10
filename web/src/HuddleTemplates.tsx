import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type HuddlePreset, type HuddleTemplate, type Level, type TeamUsage } from "./api";
import { RosterEditor, rosterDraft, templateRules, type RosterDraft } from "./HuddleRoster";
import { DEFAULT_BUDGET } from "./huddleText";
import { resetTitle, scopeChip, usageText } from "./teamText";

type Draft = { name: string; label: string; description: string; rounds: string; budget: string; report: string; roster: RosterDraft };

/** Enter in these inputs must not submit anything around them. */
const noSubmit = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
};

const toDraft = (t: HuddleTemplate | null): Draft => ({
  name: t?.name ?? "", label: t?.label ?? "", description: t?.description ?? "",
  rounds: t?.rounds ? String(t.rounds) : "", budget: String(t?.maxCostUsd ?? DEFAULT_BUDGET), report: t?.report ?? "",
  roster: rosterDraft(t?.roster ?? [{ preset: "reviewer" }]),
});

/**
 * The Team tab's Templates view: whole huddles to start from (a roster plus rounds, budget and report format), each with
 * Start huddle. Saved for all boards (default) or this board only, like teammates. Saves right away.
 */
export function TeamTemplates({ slug, templates, loading, filtered, presets, usage, startHint, newRequest, onChanged, onError, onStart }: {
  slug: string;
  /** The templates to list (filtered). */
  templates: HuddleTemplate[];
  loading: boolean;
  filtered: boolean;
  presets: HuddlePreset[] | null;
  usage: Record<string, TeamUsage> | null;
  startHint: string;
  /** Changes when "+ New template" is pressed. */
  newRequest: number;
  onChanged: () => void;
  onError: (m: string | null) => void;
  onStart: (name: string) => void;
}) {
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean; scope: Level; current: HuddleTemplate | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (t: HuddleTemplate | null) => {
    onError(null);
    setEditing({ draft: toDraft(t), isNew: !t, scope: t?.source === "board" ? "board" : "global", current: t });
  };
  useEffect(() => {
    if (newRequest) edit(null);
  }, [newRequest]);

  const save = async () => {
    if (!editing) return;
    const { draft, scope } = editing;
    setBusy(true);
    onError(null);
    try {
      await api.saveHuddleTemplate(slug, {
        name: draft.name, label: draft.label, description: draft.description, report: draft.report,
        rounds: draft.rounds.trim() ? Number(draft.rounds) : null,
        maxCostUsd: draft.budget.trim() ? Number(draft.budget) : null,
        roster: draft.roster.rows.map(({ key: _k, ...e }) => ({ ...e, focus: e.focus?.trim() || undefined })),
      }, scope);
      setEditing(null);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: HuddleTemplate) => {
    setBusy(true);
    onError(null);
    try {
      await api.deleteHuddleTemplate(slug, t.name, t.source === "global" ? "global" : "board");
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    const { draft, isNew, scope } = editing;
    const set = (patch: Partial<Draft>) => setEditing((x) => x && { ...x, draft: { ...x.draft, ...patch } });
    return (
      <div className="tm-pane tm-edit tt-edit form" onKeyDown={noSubmit}>
        <div className="tm-head"><h3>{isNew ? "New template" : editing.current?.source === "builtin" ? `Customise ${draft.label}` : `Edit ${draft.label}`}</h3></div>
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
            placeholder="How teammates report, e.g. one finding per line: [MUST|SHOULD|COULD] file:line - problem - fix. Report to @facilitator." />
        </label>
        <div className="hp-roster">
          <span className="small">Teammates</span>
          <RosterEditor presets={presets} draft={draft.roster} setDraft={(roster) => set({ roster })} tickets={[]} hostId="" hideMain disabled={busy} />
        </div>
        <div className="tm-scope">
          <span className="small">Use on</span>
          <div className="segmented" role="radiogroup" aria-label="Use on">
            {([["global", "All boards"], ["board", "This board"]] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? "on" : undefined}
                onClick={() => setEditing((x) => x && { ...x, scope: v })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost small" onClick={() => { setEditing(null); onError(null); }}>Cancel</button>
          <button type="button" className="btn primary small" onClick={save}
            disabled={busy || !draft.name.trim() || !draft.roster.rows.length || draft.roster.rows.some((r) => !r.preset && !r.role?.trim())}>
            {busy ? "Saving…" : isNew ? "Add template" : "Save template"}
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <div className="muted small tm-empty">Loading…</div>;
  if (!templates.length) return <div className="muted small tm-empty">{filtered ? "No template matches." : "No templates yet."}</div>;
  return (
    <div className="tt-list">
      {templates.map((t) => {
        const chip = scopeChip(t);
        const changed = t.source !== "builtin";
        return (
          <div key={t.name} className="tt-row">
            <div className="tt-main">
              <span className="tt-label">{t.label}</span>
              <span className="tm-name mono">{t.name}</span>
              {chip && <span className={`tm-chip ${chip.tone}`}>{chip.text}</span>}
              <span className="tm-stats">{usage ? usageText(usage[t.name]) : ""}</span>
            </div>
            {t.description && <div className="tt-desc">{t.description}</div>}
            <div className="tt-meta">{[t.roster.map((e) => `@${e.handle ?? e.preset ?? e.role}${e.count && e.count > 1 ? ` ×${e.count}` : ""}`).join(", "), templateRules(t)].filter(Boolean).join(" · ")}</div>
            <div className="tt-actions">
              <button className="btn small primary" onClick={() => onStart(t.name)} title={startHint} disabled={busy}>Start huddle…</button>
              <button className="btn small" onClick={() => edit(t)} disabled={busy}>{changed ? "Edit" : "Copy to customise"}</button>
              {changed && t.base && <button className="btn small ghost" onClick={() => remove(t)} disabled={busy} title={resetTitle(t)}>Reset</button>}
              {changed && !t.base && <button className="btn small ghost danger" onClick={() => remove(t)} disabled={busy}>Delete</button>}
            </div>
          </div>
        );
      })}
      <div className="tm-hint tt-foot">Start huddle… {startHint}</div>
    </div>
  );
}
