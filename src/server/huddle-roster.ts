// Huddle rosters, presets and @mentions: plain helpers shared by the daemon (huddle.ts) and the MCP server.
import type { HuddleMode, HuddleWorkspace } from "./types";

export const DEFAULT_MAX_PARTICIPANTS = 8;
/** Set on a huddle agent's claude process: "<huddle id>/<handle>/<token>". The token proves who is calling. */
export const HUDDLE_AGENT_ENV = "CKANBAN_HUDDLE_AGENT";
/** The MCP server/CLI forwards HUDDLE_AGENT_ENV to the daemon in this header. */
export const HUDDLE_HEADER = "x-ckanban-huddle-agent";
/** The host ticket's own session: the coordinator. */
export const MAIN_HANDLE = "main";
/** The user, posting from the board. */
export const USER_HANDLE = "you";
/** Handles no participant can take. */
export const RESERVED_HANDLES = new Set([MAIN_HANDLE, USER_HANDLE, "all", "system", "current"]);
/** Agents that may not edit tracked files run without these tools. */
export const NO_EDIT_TOOLS = "Edit,Write,NotebookEdit";
const MAX_COUNT = 8;

export interface HuddlePreset {
  role: string;
  prompt: string;
  mode: HuddleMode;
  lead: boolean;
  workspace: HuddleWorkspace;
}

/** Built-in presets (editing presets is a separate feature). */
export const HUDDLE_PRESETS: Record<string, HuddlePreset> = {
  reviewer: {
    role: "Code reviewer", mode: "tagged", lead: false, workspace: "shared",
    prompt: "Review the host ticket's changes (git diff against its base branch) for correctness bugs, risky edge cases, security problems and missing tests. " +
      "Report concrete findings with file:line and why each one matters; skip style nits.",
  },
  qa: {
    role: "QA tester", mode: "monitor", lead: false, workspace: "shared",
    prompt: "Test the work like a careful QA engineer: run the app and the tests, try edge cases and unhappy paths, and reproduce every bug with exact steps. " +
      "Put test scripts and reports in your outputs folder. Post each confirmed bug with steps to reproduce, expected and actual.",
  },
  "qa-lead": {
    role: "QA lead", mode: "monitor", lead: true, workspace: "shared",
    prompt: "Lead the QA testers: split the areas to test between them, check and de-duplicate what they find, and keep the pinned findings list current " +
      "with huddle_findings. When testing is done, send @main one consolidated list of what needs fixing, most severe first.",
  },
  engineer: {
    role: "Engineer", mode: "tagged", lead: false, workspace: "own",
    prompt: "Implement the part of the work you are given in your own worktree and branch, with tests. Commit there and tell @main the branch and what changed.",
  },
  security: {
    role: "Security reviewer", mode: "tagged", lead: false, workspace: "shared",
    prompt: "Review the host ticket's changes for security problems: injection, auth and permission gaps, secrets, unsafe file or shell use. Report each with file:line and impact.",
  },
};

/** One line of a roster: `count` participants made from a preset (or a free-form role). */
export interface RosterEntry {
  preset?: string;
  role?: string;
  count?: number;
  focus?: string;
  model?: string | null;
  mode?: HuddleMode;
  workspace?: HuddleWorkspace;
  lead?: boolean;
  /** Handle (or handle prefix when count > 1). Default: the preset or role name. */
  handle?: string;
  /** Extra instructions on top of the preset's. */
  prompt?: string;
}

const isText = (v: unknown): v is string => typeof v === "string" && !!v.trim();

export function handleBase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "agent";
}

/** What's wrong with one roster entry, or null. */
export function rosterEntryError(e: any, at = ""): string | null {
  if (!e || typeof e !== "object") return `${at}each entry must be an object`;
  if (e.preset !== undefined && (!isText(e.preset) || !HUDDLE_PRESETS[e.preset.trim()])) {
    return `${at}unknown preset "${e.preset}" (presets: ${Object.keys(HUDDLE_PRESETS).join(", ")}; or give a role instead)`;
  }
  if (e.preset === undefined && !isText(e.role)) return `${at}give a preset or a role`;
  if (e.role !== undefined && !isText(e.role)) return `${at}role must be text`;
  if (e.count !== undefined && (!Number.isInteger(e.count) || e.count < 1 || e.count > MAX_COUNT)) return `${at}count must be a whole number from 1 to ${MAX_COUNT}`;
  if (e.mode !== undefined && e.mode !== "tagged" && e.mode !== "monitor") return `${at}mode must be tagged or monitor`;
  if (e.workspace !== undefined && e.workspace !== "shared" && e.workspace !== "own") return `${at}workspace must be shared or own`;
  for (const k of ["focus", "model", "handle", "prompt"]) {
    if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") return `${at}${k} must be text`;
  }
  if (e.lead !== undefined && typeof e.lead !== "boolean") return `${at}lead must be true or false`;
  if (isText(e.handle) && RESERVED_HANDLES.has(handleBase(e.handle))) return `${at}handle "${e.handle}" is reserved`;
  return null;
}

/** What's wrong with a roster (propose_huddle, starting a huddle), or null. */
export function rosterError(roster: unknown, max = DEFAULT_MAX_PARTICIPANTS): string | null {
  if (!Array.isArray(roster) || !roster.length) return "roster must be a non-empty list";
  for (const [i, e] of roster.entries()) {
    const err = rosterEntryError(e, `entry ${i + 1}: `);
    if (err) return err;
  }
  // The coordinator (@main) counts too.
  const total = 1 + roster.reduce((n: number, e: any) => n + (e.count ?? 1), 0);
  if (total > max) return `that is ${total} participants with @main, over the limit of ${max}`;
  return null;
}

/** @handles in a message, lowercased; "all" for @all. An email address or path is not a mention. */
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@./-])@([a-z0-9][a-z0-9_-]*)/gi)) out.add(m[2].toLowerCase().replace(/[-_]+$/, ""));
  return [...out];
}
