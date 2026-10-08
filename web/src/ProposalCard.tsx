import { useState } from "react";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { Markdown } from "./Transcript";

/** Claude's proposed title/description; Apply replaces the ticket's fields. */
export function ProposalCard({ proposal, applied, onApply, keyHint }: {
  proposal: { title: string; description: string };
  applied: boolean;
  onApply: () => Promise<void>;
  /** The newest unapplied proposal: ⌘⇧Enter in the panel applies this one. */
  keyHint?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  return (
    <div className={`proposal ${applied ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed ticket</span>
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "Collapse" : "Expand"}</button>
      </div>
      {proposal.title && <div className="proposal-title">{proposal.title}</div>}
      {open && proposal.description && <div className="proposal-body"><Markdown text={proposal.description} /></div>}
      <div className="proposal-actions">
        {applied ? (
          <span className="badge ok">Applied to ticket</span>
        ) : (
          <button className="btn primary small" disabled={busy} title={keyHint ? `Apply to ticket (${MOD}⇧Enter)` : undefined}
            onClick={async () => { setBusy(true); try { await onApply(); } finally { setBusy(false); } }}>
            {busy ? "Applying…" : "Apply to ticket"}{keyHint && <KeyHint keys="⌘⇧↵" />}
          </button>
        )}
        <span className="muted small">{applied ? "You can still edit them in the details." : "Replaces the title and description. You can undo right after."}</span>
      </div>
    </div>
  );
}
