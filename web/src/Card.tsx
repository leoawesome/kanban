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
  const working = ticket.status === "in_progress" || !!ticket.running;
  const att = working ? null : ticket.attention ?? null;
  const badge = att ? null : outcomeBadge(ticket);
  const showActivity = working && ticket.lastActivity;
  const last = ticket.session?.lastMessage;
  return (
    <article
      className={`card ${dragging ? "dragging" : ""} ${working ? "is-running" : ""} ${att ? `needs-you att-${att.kind}` : ""}`}
      onClick={onClick}>
      {att && (
        <div className={`your-turn att-${att.kind}`}>
          <span className="yt-dot" aria-hidden />
          <span className="yt-label">Your turn</span>
          <span className="yt-why">{att.label}</span>
        </div>
      )}
      <div className="card-title">{ticket.title}</div>
      {showActivity ? (
        <div className="card-activity" title={ticket.lastActivity!}>
          <span className="spinner" /> {ticket.lastActivity}
        </div>
      ) : last && (
        <div className="card-last" title={last.text}>
          <span className={`who ${last.role}`}>{last.role === "user" ? "You" : "Claude"}:</span>{" "}
          {plainPreview(last.text)}
        </div>
      )}
      {(badge || ticket.prUrl || ticket.runCount > 0 || ticket.workdir || ticket.session || ticket.scheduleId) && (
        <div className="card-meta">
          {ticket.scheduleId && (
            <span className="badge sched" title="Created by a schedule" aria-label="Scheduled">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <circle cx="8" cy="8" r="6.2" />
                <path d="M8 4.6V8l2.4 1.6" strokeLinecap="round" />
              </svg>
            </span>
          )}
          {badge}
          {ticket.prUrl && (
            <a className="badge pr" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              PR #{ticket.prUrl.split("/").pop()}
            </a>
          )}
          {ticket.workdir && (ticket.terminalOpen
            ? <span className="badge running" title="This ticket's Claude session is open in a terminal"><span className="live-dot" /> In terminal</span>
            : <span className="badge stopped" title="Linked to an existing Claude session">session</span>)}
          {ticket.session && !working && (
            <span className="muted small">{timeAgo(ticket.session.lastMessage?.at || ticket.session.updatedAt)}</span>
          )}
        </div>
      )}
    </article>
  );
}
