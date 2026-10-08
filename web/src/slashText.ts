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

/** What may sit right before a `/` that starts a skill name in free text: start, whitespace or an opening bracket/quote (not "a/b"). */
const BEFORE_SLASH = /[\s([{"'`]/;
const NAME_CHAR = /[\w.:-]/;

/** The `/query` the caret is in anywhere in a description, if any: `start` is the index of the `/`. */
export function inlineSlashQuery(value: string, caret: number): { start: number; query: string } | null {
  let i = caret;
  while (i > 0 && caret - i < 80 && NAME_CHAR.test(value[i - 1])) i--;
  if (i === 0 || value[i - 1] !== "/") return null;
  const at = i - 1;
  if (at > 0 && !BEFORE_SLASH.test(value[at - 1])) return null;
  return { start: at, query: value.slice(i, caret) };
}

/** Replace the `/query` at `start` (and the rest of that word) with `/name `; caret goes after the space. */
export function insertInlineCommand(value: string, start: number, name: string): { value: string; caret: number } {
  let end = start + 1;
  while (end < value.length && NAME_CHAR.test(value[end])) end++;
  const head = `/${name}`;
  const rest = value.slice(end);
  const sep = /^\s/.test(rest) ? "" : " ";
  return { value: value.slice(0, start) + head + sep + rest, caret: start + head.length + 1 };
}

/** Text split into plain parts and `/name` mentions of known commands (trailing punctuation stays text). */
export function splitCommandMentions(text: string, known: (name: string) => boolean): (string | { name: string })[] {
  const out: (string | { name: string })[] = [];
  const re = /\/([A-Za-z0-9][\w:-]*(?:\.[\w:-]+)*)/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > 0 && !BEFORE_SLASH.test(text[m.index - 1])) continue;
    // Part of a path ("/skills/x") rather than a mention.
    if (text[m.index + m[0].length] === "/" || !known(m[1])) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
