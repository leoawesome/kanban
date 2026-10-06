import { useState } from "react";
import type { Ticket } from "./api";
import { BranchIcon } from "./icons";

/** Claude offered to branch the ticket (propose_branch); the click does the branching. */
export function BranchCard({ reason, branch, here, running, onBranch, onOpen }: {
  reason: string;
  /** The branch made after this offer, if any. */
  branch: Ticket | undefined;
  /** The offer was copied into this ticket: this ticket is the branch. */
  here: boolean;
  running: boolean;
  onBranch: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const done = here || !!branch;
  return (
    <div className={`proposal branch-card ${done ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag"><BranchIcon size={12} /> Branch this ticket</span>
      </div>
      {reason && <div className="branch-reason">{reason}</div>}
      <div className="proposal-actions">
        {here ? (
          <span className="badge ok">Branched: this ticket</span>
        ) : branch ? (
          <>
            <span className="badge ok">Branched</span>
            <button className="link-btn ticket-link" onClick={() => onOpen(branch.id)}>{branch.title}</button>
          </>
        ) : (
          <>
            <button className="btn primary small" disabled={busy || running} title={running ? "Wait until Claude is done" : undefined}
              onClick={async () => { setBusy(true); try { await onBranch(); } finally { setBusy(false); } }}>
              {busy ? "Branching…" : "Branch"}
            </button>
            <span className="muted small">
              {running ? "Wait until Claude is done." : "New ticket in Planning with a copy of this conversation and the committed code. This one stays as it is."}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
