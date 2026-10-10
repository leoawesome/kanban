import { useLayoutEffect, useRef, useState } from "react";
import type { HuddlePreset, Level, TeammateCardState, TeammateProposal } from "./api";
import { TeammateAvatar } from "./Team";
import { proposedTeammate, savedText, teammateDiff, teammateMeta, type TeammateDraft } from "./teammateText";

/**
 * Claude proposed a teammate (propose_teammate). The user saves it with one click for all boards (default) or this board,
 * opens it in the Team tab's editor first, or dismisses it. A proposal for an existing handle shows what it changes.
 * answered: what the user did (the ticket's teammateCards); presets: the board's teammates (null while loading).
 */
export function TeammateCard({ proposal, presets, answered, onSave, onEdit, onDismiss, onOpenTeam }: {
  proposal: TeammateProposal;
  presets: HuddlePreset[] | null;
  answered?: TeammateCardState;
  onSave: (scope: Level) => Promise<void>;
  onEdit?: (scope: Level, draft: TeammateDraft, isNew: boolean) => void;
  onDismiss: () => Promise<void>;
  onOpenTeam?: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (answered?.state === "saved") {
    const name = answered.name ?? proposal.name;
    return (
      <div className="proposal teammate-card applied">
        <span className="proposal-tag">Teammate saved</span>
        <div className="proposal-actions">
          <span className="badge ok">{savedText(name, answered.scope)}</span>
          {onOpenTeam && <button className="btn small ghost" onClick={() => onOpenTeam(name)}>Open in Team</button>}
        </div>
      </div>
    );
  }
  const run = (p: Promise<void>) => {
    setBusy(true);
    p.finally(() => setBusy(false));
  };
  return (
    <TeammateProposalView proposal={proposal} presets={presets} dismissed={answered?.state === "dismissed"} busy={busy}
      onSave={(scope) => run(onSave(scope))}
      onEdit={onEdit && ((scope, draft, isNew) => onEdit(scope, draft, isNew))}
      onDismiss={() => run(onDismiss())} />
  );
}

/** The proposal itself: avatar, label and handle, plain meta, the prompt (4 lines, expandable), why, and the Save to toggle. */
export function TeammateProposalView({ proposal, presets, dismissed, busy, initialScope = "global", scopeLocked, saveLabel, dismissLabel = "Dismiss", onSave, onEdit, onDismiss, onScope }: {
  proposal: TeammateProposal;
  presets: HuddlePreset[] | null;
  dismissed?: boolean;
  busy?: boolean;
  initialScope?: Level;
  /** The toggle can't change (e.g. while saving). */
  scopeLocked?: boolean;
  saveLabel?: string;
  dismissLabel?: string;
  onSave: (scope: Level) => void;
  onEdit?: (scope: Level, draft: TeammateDraft, isNew: boolean) => void;
  onDismiss: () => void;
  /** The toggle changed (a huddle learning keeps it on the server). */
  onScope?: (scope: Level) => void;
}) {
  const [scope, setScope] = useState<Level>(initialScope);
  const [full, setFull] = useState(false);
  const existing = presets?.find((p) => p.name === proposal.name) ?? null;
  const next = proposedTeammate(proposal, existing);
  const diff = existing ? teammateDiff(next, existing) : [];
  // "Show full prompt" only when the 4-line clamp cuts it off.
  const promptRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (el && !full) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [next.prompt, full]);
  return (
    <div className={`proposal teammate-card${dismissed ? " done" : ""}`}>
      <span className="proposal-tag">{existing ? "Proposed change" : "Proposed teammate"}</span>
      <div className="tmc-top">
        <TeammateAvatar name={next.name} />
        <div>
          <div className="proposal-title">{next.role}</div>
          <div className="tmc-handle mono">@{next.name}</div>
        </div>
      </div>
      {existing && <div className="tmc-warn">Changes existing @{existing.name}{diff.length ? "" : " (nothing differs)"}</div>}
      {existing ? (
        diff.length > 0 && (
          <div className="tmc-diff mono">
            {diff.map((d, i) => <div key={i} className={d.kind === "-" ? "del" : "add"}>{d.kind} {d.text}</div>)}
          </div>
        )
      ) : (
        <>
          <div className="tmc-meta">{teammateMeta(next)}</div>
          <div ref={promptRef} className={`tmc-prompt${full ? " full" : ""}`}>{next.prompt}</div>
          {long && <button className="link-btn small" onClick={() => setFull(!full)}>{full ? "Show less" : "Show full prompt"}</button>}
        </>
      )}
      {proposal.why && <div className="tmc-why">Why: {proposal.why}</div>}
      <div className="proposal-actions tmc-actions">
        {dismissed ? (
          <span className="badge">Dismissed</span>
        ) : (
          <>
            <span className="tmc-meta">Save to</span>
            <div className="segmented" role="radiogroup" aria-label="Save to">
              {([["global", "All boards"], ["board", "This board"]] as const).map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? "on" : undefined} disabled={busy || scopeLocked}
                  onClick={() => { setScope(v); onScope?.(v); }}>{label}</button>
              ))}
            </div>
            <button className="btn small primary" disabled={busy} onClick={() => onSave(scope)}>{saveLabel ?? (existing ? "Apply change" : "Save teammate")}</button>
            {onEdit && <button className="btn small" disabled={busy} onClick={() => onEdit(scope, next, !existing)}>Edit first</button>}
            <button className="btn small ghost" disabled={busy} onClick={onDismiss}>{dismissLabel}</button>
          </>
        )}
      </div>
    </div>
  );
}
