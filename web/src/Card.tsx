import { useEffect, useState } from "react";
import { safeHref, type Ticket } from "./api";
import { ClockIcon } from "./icons";
import { elapsed, fullTime, plainPreview, timeAgo, useNow } from "./time";

/** Live running time: ticks every second for the first minute, then every 30s. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  const fresh = now - new Date(since).getTime() < 60_000;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fresh ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [fresh]);
  return <span className="badge-time" title={`Started ${fullTime(since)}`}> · {elapsed(since, now)}</span>;
}

function workingBadge(label: string, since?: string | null) {
  return <span className="badge running"><span className="spinner" /> {label}{since && <Elapsed since={since} />}</span>;
}

// Shown by the badge already, so the activity line would only repeat it.
const QUIET_ACTIVITY = new Set(["Starting…", "Claude is replying…"]);

export function outcomeBadge(t: Ticket) {
  if (t.status === "in_progress") return workingBadge("Running", t.runStartedAt);
  if (t.running) return workingBadge("Replying", t.runStartedAt);
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

/** queued: 1-based place in the queue for a free run slot (status `ready`). */
export function Card({ ticket, onClick, dragging, queued }: { ticket: Ticket; onClick?: () => void; dragging?: boolean; queued?: number }) {
  const working = ticket.status === "in_progress" || !!ticket.running;
  const att = working ? null : ticket.attention ?? null;
  const badge = att ? null
    : queued && !working ? <span className="badge queued" title="Starts when a run slot is free">Queued · #{queued}</span>
    : outcomeBadge(ticket);
  const showActivity = working && ticket.lastActivity && !QUIET_ACTIVITY.has(ticket.lastActivity);
  const last = ticket.session?.lastMessage;
  useNow();
  const lastAt = ticket.session ? ticket.session.lastMessage?.at || ticket.session.updatedAt : null;
  return (
    <article
      className={`card ${dragging ? "dragging" : ""} ${queued && !working ? "is-queued" : ""} ${working ? "is-running" : ""} ${att ? `needs-you att-${att.kind}` : ""}`}
      onClick={onClick}>
      {att && (
        <div className={`your-turn att-${att.kind}`}>
          <span className="yt-dot" aria-hidden />
          <span className="yt-label">Your turn</span>
          <span className="yt-why" title={ticket.error ?? undefined}>{att.label}</span>
        </div>
      )}
      <div className="card-title" title={ticket.title}>{ticket.title}</div>
      {showActivity ? (
        <div className="card-activity" title={ticket.lastActivity!}>{ticket.lastActivity}</div>
      ) : last && (
        <div className="card-last" title={last.text}>
          <span className={`who ${last.role}`}>{last.role === "user" ? "You" : "Claude"}:</span>{" "}
          {plainPreview(last.text)}
        </div>
      )}
      {(badge || ticket.prUrl || ticket.runCount > 0 || ticket.workdir || ticket.session || ticket.scheduleId || ticket.plan) && (
        <div className="card-meta">
          {ticket.plan && ticket.plan.state !== "done" && (
            <span className={`badge plan ${ticket.plan.state}`} title="This ticket runs a plan of child tickets">
              Plan {ticket.plan.state === "finishing" ? "final check" : ticket.plan.state}
            </span>
          )}
          {ticket.scheduleId && (
            <span className="badge sched" title="Created by a schedule" aria-label="Scheduled">
              <ClockIcon size={11} strokeWidth={1.8} />
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
          {lastAt && !working && (
            <time className="card-time" dateTime={lastAt} title={fullTime(lastAt)}>{timeAgo(lastAt)}</time>
          )}
        </div>
      )}
    </article>
  );
}
