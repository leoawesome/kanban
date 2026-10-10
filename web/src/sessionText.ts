/** The huddle session viewer's helpers (kept DOM-free so the root typecheck and tests can import it). */

interface StepLike { i: number }

/** Model names as people say them: claude-sonnet-5-5 → Sonnet; null → the default model. */
export function modelLabel(model: string | null): string {
  if (!model) return "default model";
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : model;
}

/** A session id in short: 7c1e…a9. */
export const shortSession = (id: string) => (id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id);

/** The header's meta line: role · model · mode · cost · session · snapshot. */
export function sessionMeta(s: {
  role: string; model: string | null; mode: string; costUsd: number; sessionId: string | null; snapshot: { sha: string } | null; kind: string;
}): string {
  const parts = [s.role];
  if (s.kind === "agent") parts.push(modelLabel(s.model));
  parts.push(s.mode, `$${s.costUsd.toFixed(2)}`);
  if (s.sessionId) parts.push(`session ${shortSession(s.sessionId)}`);
  if (s.snapshot) parts.push(`snapshot @${s.snapshot.sha.slice(0, 7)}`);
  return parts.join(" · ");
}

/** Icon for a tool row, from its label ("Bash: ls"). */
export function toolIcon(label: string): string {
  const name = label.split(":")[0].split("__").pop()!;
  if (/^(Grep|Glob|WebSearch|ToolSearch)$/.test(name)) return "⌕";
  if (/^(Read|NotebookRead|WebFetch)$/.test(name)) return "▤";
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return "✎";
  if (/^(Bash|BashOutput|KillShell)$/.test(name)) return "$";
  if (/^(Agent|Task)$/.test(name)) return "◇";
  return "⚙";
}

/**
 * A refreshed tail of steps over what is shown: steps before the tail's first index stay, the tail replaces the
 * rest (a tool's result arriving changes a step already shown).
 */
export function mergeSteps<S extends StepLike>(shown: S[], tail: S[]): S[] {
  if (!tail.length) return shown;
  const from = tail[0].i;
  return [...shown.filter((s) => s.i < from), ...tail];
}

/** The footer's state line. */
export function sessionState(s: { kind: string; live: boolean; status: string; sessionId: string | null }, closed: boolean): string {
  if (s.kind !== "agent") return "Its session is the ticket's own chat";
  if (!s.sessionId) return "No session yet: it starts when the agent first runs";
  if (s.live) return "Live";
  const keep = closed ? "the huddle is closed; its steps stay viewable" : "steps stay viewable after the huddle closes";
  const word = { failed: "Failed", stopped: "Stopped", done: "Done", blocked: "Blocked", idle: "Finished its turn", working: "Between turns" }[s.status] ?? "Finished";
  return `${word} · ${keep}`;
}
