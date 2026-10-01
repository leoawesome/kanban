import { useState } from "react";
import { api, COLUMNS, type Ticket } from "./api";

const STATE_LABEL: Record<string, [string, string]> = {
  running: ["Running", "running"],
  finishing: ["Final check", "running"],
  paused: ["Paused", "stopped"],
  stuck: ["Stuck", "blocked"],
  done: ["Done", "ok"],
};

/** Done, or finished in Review without a PR to merge (same rule as the server's plan.ts). */
const complete = (t: Ticket) => t.status === "done" || (t.status === "review" && t.outcome === "done" && !t.prUrl);

/** A planner's children, plus Start / Pause / Resume for running them unattended in dependency order. */
export function PlanPanel({ slug, ticket, children, onOpenTicket, onError }: {
  slug: string;
  ticket: Ticket;
  children: Ticket[];
  onOpenTicket: (id: string) => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const plan = ticket.plan ?? null;
  const done = children.filter(complete).length;
  const act = async (action: "start" | "pause" | "resume" | "concurrency", n?: number) => {
    setBusy(true);
    try {
      await api.plan(slug, ticket.id, action, n);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  // Before the plan starts the choice stays here; Start plan sends it.
  const [draftCap, setDraftCap] = useState(2);
  const live = !!plan && plan.state !== "done";
  const cap = live ? plan!.maxConcurrent : draftCap;
  const [label, tone] = plan ? STATE_LABEL[plan.state] ?? [plan.state, "stopped"] : ["Not started", "stopped"];
  const titleOf = (ref: string) => children.find((c) => c.id === ref || c.planKey === ref)?.title ?? ref;
  return (
    <section className="detail-section plan-panel">
      <div className="section-head">
        <h4>Plan · {done}/{children.length} done</h4>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      {plan?.state === "stuck" && plan.reason && <p className="field-help plan-reason">{plan.reason}</p>}
      <div className="plan-actions">
        {!plan || plan.state === "done" ? (
          <button className="btn primary small" disabled={busy || (plan?.state === "done" && done === children.length)}
            title="Children switch to auto mode and run in dependency order; Claude is woken only when one needs a decision"
            onClick={() => act("start", cap)}>Start plan</button>
        ) : plan.state === "paused" || plan.state === "stuck" ? (
          <button className="btn primary small" disabled={busy} onClick={() => act("resume")}>Resume plan</button>
        ) : (
          <button className="btn small" disabled={busy} onClick={() => act("pause")}>Pause</button>
        )}
        <label className="muted small plan-cap" title="Children of this plan in Ready or In progress at once">
          At once
          <select value={cap} disabled={busy} onChange={(e) => (live ? act("concurrency", Number(e.target.value)) : setDraftCap(Number(e.target.value)))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {plan && <span className="muted small" title="Times Claude was woken to decide something">{plan.wakeups} wake-up{plan.wakeups === 1 ? "" : "s"}</span>}
      </div>
      <ul className="child-tickets">
        {children.map((c) => (
          <li key={c.id}>
            <span className="child-main">
              <button className="link-btn ticket-link" onClick={() => onOpenTicket(c.id)}>{c.title}</button>
              {!!c.dependsOn?.length && <span className="muted small child-deps">after {c.dependsOn.map(titleOf).join(", ")}</span>}
            </span>
            <span className={`badge ${complete(c) ? "ok" : c.outcome === "failed" ? "failed" : c.outcome === "blocked" || c.outcome === "needs_input" ? "blocked" : ""}`}>
              {complete(c) ? "Done" : COLUMNS.find((x) => x.id === c.status)?.label ?? c.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
