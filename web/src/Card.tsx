import type { Ticket } from "./api";

export function outcomeBadge(t: Ticket) {
  if (t.status === "in_progress") return <span className="badge running"><span className="spinner" /> Running</span>;
  if (t.error?.startsWith("corrupt")) return <span className="badge failed">Corrupt file</span>;
  switch (t.outcome) {
    case "blocked": return <span className="badge blocked">Blocked</span>;
    case "failed": return <span className="badge failed">Failed</span>;
    case "stopped": return <span className="badge stopped">Stopped</span>;
    case "done": return t.status === "review" ? <span className="badge ok">Ready for review</span> : null;
    default: return null;
  }
}

export function Card({ ticket, onClick, dragging }: { ticket: Ticket; onClick?: () => void; dragging?: boolean }) {
  const badge = outcomeBadge(ticket);
  const showActivity = ticket.lastActivity && (ticket.status === "in_progress" || ticket.status === "review");
  return (
    <article className={`card ${dragging ? "dragging" : ""} ${ticket.status === "in_progress" ? "is-running" : ""}`} onClick={onClick}>
      <div className="card-title">{ticket.title}</div>
      {showActivity && <div className="card-activity" title={ticket.lastActivity!}>{ticket.lastActivity}</div>}
      {(badge || ticket.prUrl || ticket.runCount > 0) && (
        <div className="card-meta">
          {badge}
          {ticket.prUrl && (
            <a className="badge pr" href={ticket.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              PR #{ticket.prUrl.split("/").pop()}
            </a>
          )}
          {ticket.runCount > 0 && <span className="muted small">{ticket.runCount} run{ticket.runCount > 1 ? "s" : ""}</span>}
        </div>
      )}
    </article>
  );
}
