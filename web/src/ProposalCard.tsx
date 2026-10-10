import { useState } from "react";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { Markdown } from "./Transcript";

/** Claude's proposed title/description; Apply replaces the ticket's fields, Apply & start work also moves it to Ready. */
export function ProposalCard({ proposal, applied, started, onApply, onApplyStart, keyHint }: {
  proposal: { title: string; description: string };
  applied: boolean;
  /** Applied with "Apply & start work" in this session. */
  started?: boolean;
  onApply: () => Promise<void>;
  /** Set when the ticket can start from here (Backlog/Planning, Claude idle). */
  onApplyStart?: () => Promise<void>;
  /** The newest unapplied proposal: ⌘⇧Enter in the panel applies this one (and starts work when it can). */
  keyHint?: boolean;
}) {
  const [busy, setBusy] = useState<"apply" | "start" | null>(null);
  const [open, setOpen] = useState(true);
  const run = (kind: "apply" | "start", fn: () => Promise<void>) => async () => {
    setBusy(kind);
    try { await fn(); } finally { setBusy(null); }
  };
  const hint = keyHint ? `${MOD}⇧Enter` : null;
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
          <span className="badge ok">{started ? "Applied · moved to Ready" : "Applied to ticket"}</span>
        ) : onApplyStart ? (
          <>
            <button className="btn primary small" disabled={!!busy} title={hint ? `Apply & start work (${hint})` : undefined}
              onClick={run("start", onApplyStart)}>
              {busy === "start" ? "Starting…" : "Apply & start work"}{keyHint && <KeyHint keys="⌘⇧↵" />}
            </button>
            <button className="btn small" disabled={!!busy} onClick={run("apply", onApply)}>
              {busy === "apply" ? "Applying…" : "Apply only"}
            </button>
          </>
        ) : (
          <button className="btn primary small" disabled={!!busy} title={hint ? `Apply to ticket (${hint})` : undefined}
            onClick={run("apply", onApply)}>
            {busy === "apply" ? "Applying…" : "Apply to ticket"}{keyHint && <KeyHint keys="⌘⇧↵" />}
          </button>
        )}
        <span className="muted small">
          {applied
            ? started ? "Claude starts when a slot is free." : "You can still edit them in the details."
            : onApplyStart
              ? "Replaces the title and description. Start work moves it to Ready; Claude works on its own."
              : "Replaces the title and description. You can undo right after."}
        </span>
      </div>
    </div>
  );
}
