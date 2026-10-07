import { useEffect, useState } from "react";
import { api, type AgentInfo, type AgentStep, type SessionEntry } from "./api";
import { duration, fullTime } from "./time";
import { Markdown } from "./Transcript";

/** Rows the user opened; module-level so they stay open across live refreshes and ticket switches. */
const opened = new Set<string>();

const STATUS_LABEL: Record<AgentInfo["status"], string> = { running: "running", done: "done", failed: "failed", stopped: "stopped" };

/** Subagents Claude started in a row of the conversation, one expandable row each. */
export function AgentRows({ slug, ticketId, items, old }: { slug: string; ticketId: string; items: SessionEntry[]; old: boolean }) {
  return (
    <div className={`agents${old ? " inherited" : ""}`}>
      {items.map((e) => e.agent && <AgentRow key={e.uuid} slug={slug} ticketId={ticketId} agent={e.agent} />)}
    </div>
  );
}

function AgentRow({ slug, ticketId, agent: a }: { slug: string; ticketId: string; agent: AgentInfo }) {
  const [open, setOpen] = useState(() => opened.has(a.toolUseId));
  // All steps, once the user asked for them ("show all"); refetched while the agent keeps adding steps.
  const [all, setAll] = useState<AgentStep[] | null>(null);
  const [loading, setLoading] = useState(false);
  const running = a.status === "running";
  const now = useTicker(running);

  const wantAll = all !== null;
  useEffect(() => {
    if (!wantAll || a.stepCount <= (all?.length ?? 0)) return;
    api.agent(slug, ticketId, a.toolUseId).then((full) => setAll(full.steps)).catch(() => {});
  }, [wantAll, a.stepCount]);

  const showAll = () => {
    setLoading(true);
    api.agent(slug, ticketId, a.toolUseId)
      .then((full) => setAll(full.steps))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const steps = all ?? a.steps;
  const hidden = a.stepCount - steps.length;
  const time = duration(a.startedAt, a.endedAt ? new Date(a.endedAt).getTime() : running ? now : new Date(a.updatedAt).getTime());
  return (
    <div className={`agent ${a.status}`}>
      <details open={open}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          if (isOpen) opened.add(a.toolUseId);
          else opened.delete(a.toolUseId);
          setOpen(isOpen);
        }}>
        <summary>
          <span className="agent-chev" aria-hidden>▶</span>
          <StatusIcon status={a.status} />
          <span className="agent-name">{a.description}</span>
          {a.type && <span className="agent-type">{a.type}</span>}
          <span className={`agent-pill ${a.status}`}>{STATUS_LABEL[a.status]}</span>
          <span className="agent-meta" title={`Started ${fullTime(a.startedAt)}${a.background ? " · in the background" : ""}`}>
            {time}{a.stepCount > 0 && ` · ${a.stepCount} step${a.stepCount === 1 ? "" : "s"}`}
          </span>
        </summary>
        {open && (
          <div className="agent-body">
            {hidden > 0 && (
              <button className="link-btn agent-more" onClick={showAll} disabled={loading}>
                {loading ? "Loading…" : `Show all ${a.stepCount} steps`}
              </button>
            )}
            {steps.length > 0 ? (
              <ul className="agent-steps">
                {steps.map((s, i) => {
                  const cur = running && s.kind === "tool" && i === steps.length - 1 && s.text === a.current;
                  return (
                    <li key={hidden + i} className={s.kind === "text" ? "txt" : cur ? "cur" : undefined} title={s.kind === "tool" ? s.text : undefined}>
                      {cur && <><span className="spinner" /> </>}{s.text}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="agent-empty">{running ? "Starting…" : "No steps recorded."}</div>
            )}
            {a.result && <div className="agent-result"><h6>Result</h6><Markdown text={a.result} /></div>}
            {a.error && <div className="agent-result error"><h6>{a.status === "stopped" ? "Stopped" : "Error"}</h6>{a.error}</div>}
            {!a.result && !a.error && a.status === "stopped" && (
              <div className="agent-result error"><h6>Stopped</h6>The agent stopped before it reported back.</div>
            )}
          </div>
        )}
      </details>
      {/* The closed <details> hides everything but its summary, so the live step sits outside it. */}
      {running && a.current && !open && <div className="agent-now" title={a.current}>{a.current}</div>}
    </div>
  );
}

function StatusIcon({ status }: { status: AgentInfo["status"] }) {
  if (status === "running") return <span className="spinner agent-icon" aria-label="running" />;
  return <span className={`agent-icon ${status}`} aria-hidden>{status === "done" ? "✓" : status === "failed" ? "✕" : "■"}</span>;
}

/** Ticks every second while `on`, for the running timer. */
function useTicker(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
