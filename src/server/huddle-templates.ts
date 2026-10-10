// Whole-huddle templates: a named roster plus the rules the huddle runs by (rounds, budget, report format).
// Built-ins ship here; a board keeps its own and its overrides in profiles/<slug>/huddle-templates.json, the same way
// as role presets (see huddle-presets.ts). Starting a huddle from a template uses its roster and budget, and its rules
// become the huddle's pinned brief. Plain helpers shared by the daemon and the MCP server (no file access here).
import { presetName } from "./huddle-presets";
import { rosterError, type RosterEntry } from "./huddle-roster";

export interface HuddleTemplate {
  /** Key, e.g. design-review. Lowercase letters, digits and dashes. */
  name: string;
  /** Shown in pickers, e.g. "Design review". */
  label: string;
  /** One line: what this huddle is for. */
  description: string;
  roster: RosterEntry[];
  /** Rounds of discussion before the lead wraps up; null: no limit. */
  rounds: number | null;
  /** Budget in USD; null: the board's default. */
  maxCostUsd: number | null;
  /** How participants report (format of findings, who to send them to); "" for none. */
  report: string;
}

export type TemplateSource = "builtin" | "board" | "override";
export type HuddleTemplateView = HuddleTemplate & { source: TemplateSource };

const MAX_TEXT = 4000;
const MAX_ROUNDS = 20;

const DESIGN_REVIEW_READ =
  "Read the code you review without changing the checkout (git show <ref>:<path>, git grep); never edit, checkout or reset. ";

export const BUILTIN_TEMPLATES: HuddleTemplate[] = [
  {
    name: "design-review",
    label: "Design review",
    description: "Several critics review a feature from different angles; a facilitator de-duplicates and ranks their findings for @main.",
    rounds: 2,
    maxCostUsd: 20,
    report: "One finding per line: [MUST|SHOULD|COULD][S|M|L] file:line - problem - concrete fix. MUST = bug, safety hole or cost leak; evidence required. " +
      "Don't repeat another participant's point: +1 it by #seq. Post findings with kind=finding and report to @facilitator, not @main.",
    roster: [
      {
        handle: "architect", role: "Architect", preset: "reviewer",
        prompt: DESIGN_REVIEW_READ + "Review the core design and engine code: routing bugs, races, recovery after restarts, cost leaks, missing tests.",
      },
      {
        handle: "ux", role: "UX critic",
        prompt: DESIGN_REVIEW_READ + "Critique the user experience: can the user tell at a glance who is doing what, what needs them, what it costs and when it is done? " +
          "Propose concrete UI changes (what, where, why), ranked by user impact.",
      },
      {
        handle: "safety", role: "Safety reviewer", preset: "security",
        prompt: DESIGN_REVIEW_READ + "For each risk give a realistic scenario, the current mitigation (or none) and a proportionate fix; this is a single-user local tool, so avoid enterprise overkill.",
      },
      {
        handle: "agentx", role: "Agent ergonomics tester",
        prompt: DESIGN_REVIEW_READ + "Review the feature from an agent's point of view: prompts, tool descriptions, message formats. " +
          "Use this very huddle as evidence: note anything confusing you hit yourself while taking part.",
      },
      {
        handle: "research", role: "Product researcher",
        prompt: "Compare the design with how other products and multi-agent frameworks solve the same problem. Use web search and cite sources. " +
          "Keep to ideas that fit the project's scale; report the top 5 with effort and benefit.",
      },
      {
        handle: "facilitator", role: "Facilitator", lead: true,
        prompt: "Run the discussion: make sure every participant posts, challenge weak or duplicate findings, ask follow-ups and settle disagreements. " +
          "Keep the pinned findings list with huddle_findings: de-duplicate, tag each MUST / SHOULD / COULD with effort S/M/L. Don't add participants unless a clear gap appears. " +
          "When the rounds are over, tag @main once with the final ranked list (about 12 items at most).",
      },
    ],
  },
];

const BUILTIN = new Map(BUILTIN_TEMPLATES.map((t) => [t.name, t]));

export const isBuiltinTemplate = (name: string) => BUILTIN.has(name);

/** Built-ins (or their board overrides) first, then the board's own templates by name. */
export function mergeTemplates(board: HuddleTemplate[]): HuddleTemplateView[] {
  const mine = new Map(board.map((t) => [t.name, t]));
  const out: HuddleTemplateView[] = BUILTIN_TEMPLATES.map((b) => {
    const o = mine.get(b.name);
    return o ? { ...o, source: "override" as const } : { ...b, source: "builtin" as const };
  });
  const added = board.filter((t) => !BUILTIN.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...added.map((t) => ({ ...t, source: "board" as const }))];
}

/**
 * A template to save, filled in from `input` over `base` (the template it overrides or edits); throws a readable
 * message when invalid. `presets`: the board's preset names, to check the roster against (omitted: shape only).
 */
export function templateFromInput(input: any, base?: HuddleTemplate, presets?: string[]): HuddleTemplate {
  if (!input || typeof input !== "object") throw new Error("template must be an object");
  const name = presetName(typeof input.name === "string" ? input.name : "");
  if (!name) throw new Error("name is required (letters, digits and dashes)");
  const text = (k: string) => {
    const v = input[k];
    if (v !== undefined && v !== null && typeof v !== "string") throw new Error(`${k} must be text`);
    if (typeof v === "string" && v.length > MAX_TEXT) throw new Error(`${k} is too long (max ${MAX_TEXT} characters)`);
    return typeof v === "string" ? v.trim() : undefined;
  };
  const roster = input.roster === undefined ? base?.roster : input.roster;
  if (roster === undefined) throw new Error("roster is required: the participants this huddle starts with");
  // Templates may name presets this board doesn't have yet; Start checks names.
  const err = rosterError(roster, 32, presets);
  if (err) throw new Error(err);
  const rounds = input.rounds === undefined ? base?.rounds ?? null : input.rounds;
  if (rounds !== null && (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)) throw new Error(`rounds must be a whole number from 1 to ${MAX_ROUNDS}, or null`);
  const cost = input.maxCostUsd === undefined ? base?.maxCostUsd ?? null : input.maxCostUsd;
  if (cost !== null && !(typeof cost === "number" && Number.isFinite(cost) && cost > 0)) throw new Error("maxCostUsd must be a positive amount, or null");
  const label = text("label") || base?.label || name.split("-").map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
  return {
    name, label,
    description: text("description") ?? base?.description ?? "",
    roster: (roster as RosterEntry[]).map((e) => ({ ...e })),
    rounds, maxCostUsd: cost,
    report: text("report") ?? base?.report ?? "",
  };
}

/** Board templates after saving `input`: replaces a board template of that name, or adds an override or a new one. */
export function saveTemplate(board: HuddleTemplate[], input: any, presets?: string[]): { board: HuddleTemplate[]; template: HuddleTemplate } {
  const name = presetName(typeof input?.name === "string" ? input.name : "");
  const base = board.find((t) => t.name === name) ?? BUILTIN.get(name);
  const template = templateFromInput(input, base, presets);
  return { board: [...board.filter((t) => t.name !== template.name), template], template };
}

/** Board templates after deleting `name`: a board template goes away, an override goes back to the built-in. */
export function deleteTemplate(board: HuddleTemplate[], name: string): { board: HuddleTemplate[]; reset: boolean } {
  const n = presetName(name);
  if (!board.some((t) => t.name === n)) {
    if (BUILTIN.has(n)) throw new Error(`"${n}" is a built-in template; it can only be changed, not deleted`);
    throw new Error(`no template "${name}" on this board`);
  }
  return { board: board.filter((t) => t.name !== n), reset: BUILTIN.has(n) };
}

/** Keeps only well-formed entries from a hand-edited or old huddle-templates.json. */
export function cleanTemplates(v: unknown): HuddleTemplate[] {
  if (!Array.isArray(v)) return [];
  const out: HuddleTemplate[] = [];
  for (const x of v) {
    try {
      const t = templateFromInput(x);
      if (!out.some((o) => o.name === t.name)) out.push(t);
    } catch {}
  }
  return out;
}

/** The template's rules as the huddle's pinned brief. `budget`: the huddle's actual budget. */
export function templateBrief(t: HuddleTemplate, budget: number): string {
  return [
    `${t.label} (template ${t.name})${t.description ? `: ${t.description}` : ""}`,
    t.rounds ? `Rounds: at most ${t.rounds}. A round: everyone posts, the lead challenges and de-duplicates, each answers once. After the last round the lead wraps up.` : "",
    `Budget: $${budget}.`,
    t.report ? `Report format: ${t.report}` : "",
  ].filter(Boolean).join("\n");
}

/** One line per template, for list_huddle_presets and tool descriptions. */
export function templateLine(t: HuddleTemplateView): string {
  const who = t.roster.map((e) => `${e.count && e.count > 1 ? `${e.count}× ` : ""}${e.handle ?? e.preset ?? e.role}`).join(", ");
  const rules = [t.rounds && `${t.rounds} rounds`, t.maxCostUsd && `$${t.maxCostUsd} budget`].filter(Boolean).join(", ");
  return `- ${t.name}: ${t.label} (${who}${rules ? `; ${rules}` : ""}${t.source === "builtin" ? "; built-in" : ""})${t.description ? `\n  ${t.description}` : ""}`;
}
