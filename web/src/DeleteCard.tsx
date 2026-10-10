import { useState } from "react";
import { api, type Ticket } from "./api";
import { COLUMNS } from "./columns";
import { formKey } from "./drafts";
import { TrashIcon } from "./icons";
import { usePersistentState } from "./usePersistentState";

/**
 * Claude asked to delete tickets (propose_delete): runs can't delete, so the user's click does it, through the
 * same endpoint as the board's Delete. The outcome ("Deleted …" / "Kept.") is remembered per card.
 */
export function DeleteCard({ slug, ticket, tickets, uuid, ids, reason, onError }: {
  slug: string;
  /** The ticket whose chat shows the card; it can't delete itself from here. */
  ticket: Ticket;
  tickets: Ticket[];
  uuid: string;
  ids: string[];
  reason: string;
  onError: (msg: string) => void;
}) {
  const [result, setResult] = usePersistentState<string | null>(formKey(slug, ticket.id, `delete-${uuid}`), () => null, (v) => !v, (v) => typeof v === "string");
  const [busy, setBusy] = useState(false);
  const rows = ids.map((id) => ({ id, t: id === ticket.id ? undefined : tickets.find((x) => x.id === id) }));
  const found = rows.flatMap((r) => (r.t ? [r.t] : []));
  const gone = !result && !found.length;
  const column = (t: Ticket) => COLUMNS.find((c) => c.id === t.status)?.label ?? t.status;

  const remove = async () => {
    setBusy(true);
    const deleted: string[] = [];
    try {
      for (const t of found) {
        await api.deleteTicket(slug, t.id);
        deleted.push(t.id);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setResult(deleted.length ? `Deleted ${deleted.join(", ")}.` : "Kept.");
    }
  };

  return (
    <div className={`proposal delete-card${result || gone ? " done" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag"><TrashIcon size={12} /> {ids.length > 1 ? `Delete ${ids.length} tickets?` : "Delete ticket?"}</span>
      </div>
      <ul className="delete-list">
        {rows.map(({ id, t }) => (
          <li key={id}>
            {t ? <><b>{t.title}</b> <span className="muted small">{id} · {column(t)}</span></>
              : result ? <s className="muted small">{id}</s>
              : <span className="muted small">{id} · {id === ticket.id ? "this ticket, skipped" : "not on this board, skipped"}</span>}
          </li>
        ))}
      </ul>
      <div className="small">{found.length > 1 || (!found.length && ids.length > 1) ? "Their worktrees, branches and chats are removed." : "Its worktree, branch and chat are removed."} This can't be undone.</div>
      {reason && <div className="muted small">Reason: {reason}</div>}
      <div className="proposal-actions">
        {result ? (
          <span className={`badge ${result === "Kept." ? "" : "ok"}`}>{result}</span>
        ) : gone ? (
          <span className="muted small">None of these tickets are on the board any more.</span>
        ) : (
          <>
            <button className="btn small" disabled={busy} onClick={() => setResult("Kept.")}>Cancel</button>
            <button className="btn danger small" disabled={busy} onClick={remove}>{busy ? "Deleting…" : "Delete"}</button>
          </>
        )}
      </div>
    </div>
  );
}
