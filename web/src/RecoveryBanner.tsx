import { useEffect, useState } from "react";
import { api, type Ticket } from "./api";

/**
 * Dead-end run errors with a one-click fix. A lost session gets Start fresh session; a session open in a
 * terminal gets Take over here, which falls back to Start fresh session when the terminal isn't the board's.
 */
export function RecoveryBanner({ slug, ticket, onError }: { slug: string; ticket: Ticket; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState(false);
  // A new error (or none) starts over.
  useEffect(() => setExternal(false), [ticket.id, ticket.error]);

  const act = (call: () => Promise<{ external: boolean }>) => {
    setBusy(true);
    call()
      .then((r) => setExternal(r.external))
      .catch((e) => onError(e.message))
      .finally(() => setBusy(false));
  };
  const fresh = (
    <button className="btn small" disabled={busy} onClick={() => act(() => api.freshSession(slug, ticket.id))}>Start fresh session</button>
  );

  if (ticket.recovery === "session_missing") {
    return (
      <div className="banner error inline recovery" role="alert">
        <span>No conversation found for this session.</span>
        {fresh}
        <span className="muted small">keeps the worktree and branch; Claude gets the ticket and the last result</span>
      </div>
    );
  }
  if (external) {
    return (
      <div className="banner warn inline recovery" role="alert">
        <span>This session is open in a terminal outside the board, which the board can't close. Exit it there (Ctrl+D or /exit), or start fresh here.</span>
        {fresh}
        <span className="muted small">a new session on the same worktree and branch; Claude gets the ticket and the last result</span>
      </div>
    );
  }
  return (
    <div className="banner warn inline recovery" role="alert">
      <span>This session is still open in a terminal.</span>
      <button className="btn small" disabled={busy} onClick={() => act(() => api.takeOver(slug, ticket.id))}>
        {busy ? "Taking over…" : "Take over here"}
      </button>
      <span className="muted small">closes it in the terminal and resumes here</span>
    </div>
  );
}
