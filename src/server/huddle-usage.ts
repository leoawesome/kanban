// How each teammate (preset) and template has been used: counted from the huddle files every board keeps, closed ones
// included. Plain helpers (the daemon reads the files, see Huddles.usage).
import type { Huddle } from "./types";

/** One huddle a teammate or template took part in. */
export interface UsageHuddle {
  board: string;
  huddle: string;
  ticket: string;
  title: string | null;
  /** When it joined (teammate) or the huddle started (template). */
  at: string;
  /** Teammate: what its participants spent there. Template: the whole huddle's cost. */
  costUsd: number;
}

export interface Usage {
  huddles: number;
  lastUsed: string | null;
  costUsd: number;
  /** Newest first. */
  recent: UsageHuddle[];
}

export interface UsageInput {
  board: string;
  huddle: Huddle;
  /** The host ticket's title. */
  title: string | null;
}

/** Recent huddles kept per teammate or template. */
export const RECENT_HUDDLES = 5;

function add(map: Map<string, UsageHuddle[]>, key: string, u: UsageHuddle) {
  const list = map.get(key);
  if (list) list.push(u);
  else map.set(key, [u]);
}

function summary(list: UsageHuddle[]): Usage {
  const recent = [...list].sort((a, b) => b.at.localeCompare(a.at));
  return {
    huddles: list.length,
    lastUsed: recent[0]?.at ?? null,
    costUsd: Math.round(list.reduce((n, u) => n + u.costUsd, 0) * 10000) / 10000,
    recent: recent.slice(0, RECENT_HUDDLES),
  };
}

/** Usage per preset name (several participants from one preset in a huddle count once) and per template name. */
export function huddleUsage(input: UsageInput[]): { teammates: Record<string, Usage>; templates: Record<string, Usage> } {
  const byPreset = new Map<string, UsageHuddle[]>();
  const byTemplate = new Map<string, UsageHuddle[]>();
  for (const { board, huddle: h, title } of input) {
    const base = { board, huddle: h.id, ticket: h.hostTicket, title };
    const presets = new Map<string, { at: string; costUsd: number }>();
    for (const p of h.participants) {
      if (!p.preset || p.kind === "human") continue;
      const cur = presets.get(p.preset);
      const at = p.joinedAt || h.createdAt;
      presets.set(p.preset, { at: cur && cur.at > at ? cur.at : at, costUsd: (cur?.costUsd ?? 0) + (p.costUsd ?? 0) });
    }
    for (const [name, u] of presets) add(byPreset, name, { ...base, ...u });
    if (h.template) add(byTemplate, h.template, { ...base, at: h.createdAt, costUsd: h.participants.reduce((n, p) => n + (p.costUsd ?? 0), 0) });
  }
  const out = (m: Map<string, UsageHuddle[]>) => Object.fromEntries([...m].map(([k, v]) => [k, summary(v)]));
  return { teammates: out(byPreset), templates: out(byTemplate) };
}
