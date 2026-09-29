import { safeHref, type Ticket } from "./api";
import { plainPreview, timeAgo } from "./time";

export function outcomeBadge(t: Ticket) {
  if (t.status === "in_progress") return <span className="badge running"><span className="spinner" /> Running</span>;
  if (t.running) return <span className="badge running"><span className="spinner" /> Replying</span>;
  if (t.error?.startsWith("corrupt")) return <span className="badge failed">Corrupt file</span>;
  switch (t.outcome) {
    case "blocked": return <span className="badge blocked">Blocked</span>;
    case "needs_input": return <span className="badge blocked">Needs your input</span>;
    case "failed": return <span className="badge failed">Failed</span>;
    case "stopped": return <span className="badge stopped">Stopped</span>;
    case "done": return t.status === "review" ? <span className="badge ok">Ready for review</span> : null;
    default: return null;
  }
}

export function Card({ ticket, onClick, dragging }: { ticket: Ticket; onClick?: () => void; dragging?: boolean }) {
  const badge = outcomeBadge(ticket);
  const showActivity = ticket.lastActivity && (ticket.status === "in_progress" || (ticket.status === "review" && !ticket.session?.lastMessage));
  return (
    <article className={`card ${dragging ? "dragging" : ""} ${ticket.status === "in_progress" ? "is-running" : ""}`} onClick={onClick}>
      <div className="card-title">{ticket.title}</div>
      {showActivity ? (
        <div className="card-activity" title={ticket.lastActivity!}>{ticket.lastActivity}</div>
      ) : ticket.session?.lastMessage && (
        <div className="card-last" title={ticket.session.lastMessage.text}>
          <span className={`who ${ticket.session.lastMessage.role}`}>{ticket.session.lastMessage.role === "user" ? "You" : "Claude"}:</span>{" "}
          {plainPreview(ticket.session.lastMessage.text)}
        </div>
      )}
      {(badge || ticket.prUrl || ticket.runCount > 0 || ticket.workdir || ticket.session) && (
        <div className="card-meta">
          {badge}
          {ticket.prUrl && (
            <a className="badge pr" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              PR #{ticket.prUrl.split("/").pop()}
            </a>
          )}
          {ticket.workdir && <span className="badge stopped" title="Linked to an existing Claude session">session</span>}
          {ticket.session && ticket.status !== "in_progress" && (
            <span className="muted small">{timeAgo(ticket.session.lastMessage?.at || ticket.session.updatedAt)}</span>
          )}
          {ticket.runCount > 0 && <span className="muted small">{ticket.runCount} run{ticket.runCount > 1 ? "s" : ""}</span>}
        </div>
      )}
    </article>
  );
}
