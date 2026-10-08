import { fuzzyMatch } from "./fuzzy";

/** A slash command a ticket chat can run (GET <ticket>/commands). */
export interface SlashCommand {
  name: string;
  kind: "skill" | "command" | "builtin";
  /** claude: bundled with Claude Code; board: the board runs it itself. */
  source: "user" | "project" | "plugin" | "claude" | "board";
  description: string;
}

export const SLASH_GROUPS: { kind: SlashCommand["kind"]; label: string }[] = [
  { kind: "skill", label: "Skills" },
  { kind: "command", label: "Commands" },
  { kind: "builtin", label: "Built-ins" },
];

/** The `/query` being typed: only as the message's first word, with the caret still in it. */
export function slashQuery(value: string, caret: number): string | null {
  if (!value.startsWith("/")) return null;
  const word = value.slice(1, caret);
  return /^[\w.:-]*$/.test(word) && !/\s/.test(value.slice(0, caret)) ? word : null;
}

/**
 * Matches for the query, grouped by kind in picker order. Names starting with it win: when there are any, fuzzy
 * matches are left out, so a fuzzy skill never sits above (and gets picked instead of) /model for "/mo".
 */
export function matchCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const scored = list.flatMap((c) => {
    const name = c.name.toLowerCase();
    // Plugin skills match on their own name too: "/brain" finds superpowers:brainstorming.
    const short = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    // A skill's own name beats its plugin's: "/re" means retro before respond-io:anything.
    if (short.startsWith(q) || name.startsWith(q)) return [{ c, rank: 0, score: short.startsWith(q) ? 0 : 1 }];
    const m = fuzzyMatch(name, q);
    return m ? [{ c, rank: 1, score: m.score }] : [];
  });
  const order = (k: SlashCommand["kind"]) => SLASH_GROUPS.findIndex((g) => g.kind === k);
  const prefix = scored.filter((x) => x.rank === 0);
  return (prefix.length ? prefix : scored)
    .sort((a, b) => order(a.c.kind) - order(b.c.kind) || a.rank - b.rank || a.score - b.score || a.c.name.localeCompare(b.c.name))
    .map((s) => s.c);
}

/** The command a sent message starts with, if it's one the chat knows. */
export function messageCommand(text: string, list: SlashCommand[] | null): SlashCommand | null {
  const name = /^\/([\w.:-]+)(?=\s|$)/.exec(text.trim())?.[1];
  return (name && list?.find((c) => c.name === name)) || null;
}

/** The note under a sent command: what ran it. */
export function commandNote(c: SlashCommand | null): string {
  if (!c) return "Runs command";
  if (c.source === "board") return "Board command";
  const from = c.source === "claude" ? "Claude Code" : c.source;
  return c.kind === "skill" ? `Runs skill · ${from}` : c.kind === "command" ? `Runs command · ${from}` : "Claude Code command";
}

/** Tag shown on the right of a picker row. */
export function sourceLabel(c: SlashCommand): string {
  return c.source === "claude" ? "claude code" : c.source;
}
