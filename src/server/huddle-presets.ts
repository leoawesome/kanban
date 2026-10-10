// Huddle role presets: built-ins shipped here, plus per-board overrides and additions in
// profiles/<slug>/huddle-presets.json. A board preset with a built-in's name overrides it; deleting it resets the built-in.
// Plain helpers shared by the daemon and the MCP server (no file access here; see Store.listHuddlePresets).
import type { HuddleMode, HuddleWorkspace } from "./types";

export interface HuddlePreset {
  /** Key used in rosters, and the default handle. Lowercase letters, digits and dashes. */
  name: string;
  /** Label shown in the huddle, e.g. "QA lead". */
  role: string;
  prompt: string;
  /** Default model, e.g. sonnet; null: the board's. */
  model: string | null;
  mode: HuddleMode;
  /** May add participants and manage the findings list. */
  lead: boolean;
  /** May edit tracked files (only ever in its own worktree; a shared-workspace agent never edits). */
  canEdit: boolean;
  workspace: HuddleWorkspace;
}

export type PresetSource = "builtin" | "board" | "override";
export type HuddlePresetView = HuddlePreset & { source: PresetSource };

/** The coordinator's preset: the host ticket's own session. Only its role, mode and prompt apply. */
export const MAIN_PRESET = "main";
/** Preset names that would clash with special handles. */
const RESERVED_NAMES = new Set(["you", "all", "system", "current"]);
const MAX_NAME = 24;
const MAX_PROMPT = 8000;

export const BUILTIN_PRESETS: HuddlePreset[] = [
  {
    name: MAIN_PRESET, role: "Coordinator", model: null, mode: "tagged", lead: true, canEdit: true, workspace: "shared",
    prompt: "Coordinate the huddle: split the work, decide what gets fixed, make the fixes in your worktree, and tell the user (@you) when the huddle's work is done.",
  },
  {
    name: "reviewer", role: "Code reviewer", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Review the host ticket's changes (git diff against its base branch) for correctness bugs, risky edge cases, security problems and missing tests. " +
      "Report concrete findings with file:line and why each one matters; skip style nits.",
  },
  {
    name: "qa", role: "QA tester", model: null, mode: "monitor", lead: false, canEdit: false, workspace: "shared",
    prompt: "Test the work like a careful QA engineer: run the app and the tests, try edge cases and unhappy paths, and reproduce every bug with exact steps. " +
      "Put test scripts and reports in your outputs folder. Post each confirmed bug with steps to reproduce, expected and actual.",
  },
  {
    name: "qa-lead", role: "QA lead", model: null, mode: "monitor", lead: true, canEdit: false, workspace: "shared",
    prompt: "Lead the QA testers: split the areas to test between them, check and de-duplicate what they find, and keep the pinned findings list current " +
      "with huddle_findings. When testing is done, send @main one consolidated list of what needs fixing, most severe first.",
  },
  {
    name: "engineer", role: "Engineer", model: null, mode: "tagged", lead: false, canEdit: true, workspace: "own",
    prompt: "Implement the part of the work you are given in your own worktree and branch, with tests. Commit there and tell @main the branch and what changed.",
  },
  {
    name: "security", role: "Security reviewer", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Review the host ticket's changes for security problems: injection, auth and permission gaps, secrets, unsafe file or shell use. Report each with file:line and impact.",
  },
];

const BUILTIN = new Map(BUILTIN_PRESETS.map((p) => [p.name, p]));

export const isBuiltinPreset = (name: string) => BUILTIN.has(name);

/** "QA Lead" -> "qa-lead". */
export function presetName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_NAME);
}

/** Built-ins (or their board overrides) first in their usual order, then the board's own presets by name. */
export function mergePresets(board: HuddlePreset[]): HuddlePresetView[] {
  const mine = new Map(board.map((p) => [p.name, p]));
  const out: HuddlePresetView[] = BUILTIN_PRESETS.map((b) => {
    const o = mine.get(b.name);
    return o ? { ...o, source: "override" as const } : { ...b, source: "builtin" as const };
  });
  const added = board.filter((p) => !BUILTIN.has(p.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...added.map((p) => ({ ...p, source: "board" as const }))];
}

/** A preset to save, filled in from `input` over `base` (the preset it overrides or edits, if any); throws a readable message when invalid. */
export function presetFromInput(input: any, base?: HuddlePreset): HuddlePreset {
  if (!input || typeof input !== "object") throw new Error("preset must be an object");
  const name = presetName(typeof input.name === "string" ? input.name : "");
  if (!name) throw new Error("name is required (letters, digits and dashes)");
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is reserved; pick another name`);
  const text = (k: string) => {
    const v = input[k];
    if (v !== undefined && v !== null && typeof v !== "string") throw new Error(`${k} must be text`);
    return typeof v === "string" ? v.trim() : undefined;
  };
  const flag = (k: string) => {
    const v = input[k];
    if (v !== undefined && typeof v !== "boolean") throw new Error(`${k} must be true or false`);
    return v as boolean | undefined;
  };
  const prompt = text("prompt") || base?.prompt;
  if (!prompt) throw new Error("prompt is required: what this role does in the huddle");
  if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too long (max ${MAX_PROMPT} characters)`);
  const mode = input.mode ?? base?.mode ?? "tagged";
  if (mode !== "tagged" && mode !== "monitor") throw new Error("mode must be tagged or monitor");
  const workspace = input.workspace ?? base?.workspace ?? "shared";
  if (workspace !== "shared" && workspace !== "own") throw new Error("workspace must be shared or own");
  // Omitted: keep the base's model; null or "": the board's.
  const model = input.model === undefined ? base?.model ?? null : text("model") || null;
  const role = text("role") || base?.role || name.split("-").map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
  return {
    name, role, prompt, model, mode, workspace,
    lead: flag("lead") ?? base?.lead ?? false,
    canEdit: flag("canEdit") ?? base?.canEdit ?? workspace === "own",
  };
}

/** Board presets after saving `input`: replaces a board preset of that name, or adds an override/new one. */
export function savePreset(board: HuddlePreset[], input: any): { board: HuddlePreset[]; preset: HuddlePreset } {
  const name = presetName(typeof input?.name === "string" ? input.name : "");
  const base = board.find((p) => p.name === name) ?? BUILTIN.get(name);
  const preset = presetFromInput(input, base);
  return { board: [...board.filter((p) => p.name !== preset.name), preset], preset };
}

/** Board presets after deleting `name`: a board preset goes away, an override goes back to the built-in. */
export function deletePreset(board: HuddlePreset[], name: string): { board: HuddlePreset[]; reset: boolean } {
  const n = presetName(name);
  if (!board.some((p) => p.name === n)) {
    if (BUILTIN.has(n)) throw new Error(`"${n}" is a built-in preset; it can only be overridden (save_huddle_preset), not deleted`);
    throw new Error(`no preset "${name}" on this board`);
  }
  return { board: board.filter((p) => p.name !== n), reset: BUILTIN.has(n) };
}

/** Keeps only well-formed entries from a hand-edited or old huddle-presets.json. */
export function cleanPresets(v: unknown): HuddlePreset[] {
  if (!Array.isArray(v)) return [];
  const out: HuddlePreset[] = [];
  for (const x of v) {
    try {
      const p = presetFromInput(x);
      if (!out.some((o) => o.name === p.name)) out.push(p);
    } catch {}
  }
  return out;
}

/** One line per preset, for list_huddle_presets and tool descriptions. */
export function presetLine(p: HuddlePresetView): string {
  const tags = [p.mode, p.workspace === "own" ? "own worktree" : "shared worktree", p.lead && "lead", p.canEdit && p.workspace === "own" && "edits", p.model && `model ${p.model}`];
  const src = p.source === "builtin" ? "built-in" : p.source === "override" ? "built-in, changed on this board" : "board";
  return `- ${p.name}: ${p.role} (${tags.filter(Boolean).join(", ")}; ${src})${p.name === MAIN_PRESET ? " [the coordinator, @main; not for rosters]" : ""}\n  ${p.prompt}`;
}
