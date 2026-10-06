import { useCallback, useEffect, useState } from "react";
import { api, subscribe } from "./api";
import { fullTime, timeAgo } from "./time";
import { approxPct, costText, modelName, RUN_KIND_LABEL, tokenText, type TicketUsage } from "./usage";

/** A ticket's usage, reloaded when one of its runs reports a result. */
export function useTicketUsage(slug: string, ticketId: string) {
  const [usage, setUsage] = useState<TicketUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.ticketUsage(slug, ticketId)
      .then((u) => { setUsage(u); setError(null); })
      .catch((e: Error) => setError(e.message || "Could not load usage"));
  }, [slug, ticketId]);
  useEffect(() => {
    setUsage(null);
    load();
  }, [load]);
  useEffect(() => subscribe((e) => {
    if (e.type === "activity" && e.profile === slug && e.id === ticketId && e.event?.type === "result") load();
  }), [slug, ticketId, load]);
  return { usage, error, reload: load };
}

/** Why a % is missing, for tooltips. */
export function missingPctReason(u: TicketUsage): string {
  return u.windowError
    ? `No 5h usage data: ${u.windowError}`
    : "No 5h usage window seen for this time yet. The board reads it from Anthropic when you open the Usage pill or this tab.";
}

/** Sidebar chip text: "≈ 6% of 5h · $4.12". */
export function usageChipText(u: TicketUsage): string {
  const p = u.totals.pctCurrentWindow;
  return p === null ? costText(u.totals.costUsd) : `${approxPct(p)} of 5h · ${costText(u.totals.costUsd)}`;
}

export function UsagePanel({ usage, error }: { usage: TicketUsage | null; error: string | null }) {
  if (error && !usage) return <p className="usage-error">{error}</p>;
  if (!usage) return <p className="muted small">Loading…</p>;
  if (!usage.runs.length) {
    return <p className="muted small">No finished runs yet. Cost and plan usage show up here once Claude has worked on this ticket.</p>;
  }
  const { totals, window: w } = usage;
  const missing = missingPctReason(usage);
  const maxPct = Math.max(0, ...usage.runs.map((r) => r.pct5h ?? 0));
  const runs = usage.runs.slice().reverse();
  return (
    <div className="ticket-usage">
      <div className="usage-stats">
        <div className="usage-stat" title={totals.pctCurrentWindow === null ? missing : undefined}>
          <b>{approxPct(totals.pctCurrentWindow)}</b>
          <span>
            of current 5h session{w && <> (now at {Math.round(w.utilization)}%, <span title={fullTime(w.seenAt)}>checked {timeAgo(w.seenAt)}</span>)</>}
          </span>
        </div>
        <div className="usage-stat" title={totals.pctLifetime === null ? missing : undefined}>
          <b>{approxPct(totals.pctLifetime)}</b>
          <span>all 5h windows, lifetime</span>
        </div>
        <div className="usage-stat">
          <b>{costText(totals.costUsd)}</b>
          <span>API-equivalent · {tokenText(totals.tokens)} tokens</span>
        </div>
      </div>
      <table className="usage-table">
        <thead>
          <tr><th>Run</th><th>When</th><th>Model</th><th className="n">Tokens</th><th className="n">Cost</th><th className="n">% of 5h</th></tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={`${r.startedAt}-${i}`}>
              <td>{RUN_KIND_LABEL[r.kind] ?? r.kind}</td>
              <td title={fullTime(r.startedAt)}>
                {new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </td>
              <td title={r.model ?? undefined}>{modelName(r.model)}</td>
              <td className="n">{tokenText(r.tokens)}</td>
              <td className="n">{costText(r.costUsd)}</td>
              <td className="n" title={r.pct5h === null ? missing : undefined}>
                {approxPct(r.pct5h)}
                <span className="usage-mini"><i style={{ width: `${maxPct > 0 ? ((r.pct5h ?? 0) / maxPct) * 100 : 0}%` }} /></span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="usage-note">
        % = this ticket's share of all Claude Code usage in the window × the window's usage %. Approximate: Claude use
        outside Claude Code on this Mac (claude.ai, other machines) isn't seen, so shares can come out a bit high.
      </p>
    </div>
  );
}
