// Huddle role notes: lessons the user saved from past huddles, added to the system prompt of every new agent of that
// role. Agents only propose lessons (huddle_status done with `lessons`); only the user saves them, so an agent can never
// change what future agents are told. General notes are global (<home>/huddle-notes/<role>.md), repo notes belong
// to one board (profiles/<slug>/huddle-notes/<role>.md); `_all` holds the notes for every role.
// Each file is a Markdown list, newest first, one note per line with its source in a trailing HTML comment.
// Plain helpers shared by the daemon and its tests (file access is in Store).
import { presetName } from "./huddle-presets";

export type NoteScope = "general" | "repo";
/** The notes of every role. */
export const ALL_ROLES = "_all";
/** Lines per file that go into an agent's instructions (newest first); older ones stay stored. */
export const NOTES_CAP = 30;
/** A proposed lesson's text. */
export const LESSON_MAX = 200;
/** A note's text (the user may write longer than an agent). */
export const NOTE_MAX = 400;
/** Lessons one done can propose. */
export const MAX_LESSONS = 3;

export interface HuddleNote {
  text: string;
  /** "you" (written by the user) or the handle of the agent that proposed it. */
  by: string;
  /** YYYY-MM-DD. */
  date: string | null;
  /** The huddle it came from. */
  huddle: string | null;
}

export interface RoleNotes {
  general: HuddleNote[];
  repo: HuddleNote[];
}

/** A role key for a notes file: "_all", or a preset name. Null when it can't be one. */
export function noteRole(s: unknown): string | null {
  if (typeof s !== "string") return null;
  if (s === ALL_ROLES) return ALL_ROLES;
  const n = presetName(s);
  return n && n === s ? n : null;
}

/** One line of text: newlines and comment markers out, trimmed. */
export function noteText(s: string): string {
  return s.replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim();
}

const LINE = /^- (.*?)(?:\s*<!--\s*(.*?)\s*-->)?\s*$/;

export function parseNotes(md: string): HuddleNote[] {
  const out: HuddleNote[] = [];
  for (const line of md.split("\n")) {
    const m = LINE.exec(line.trimEnd());
    if (!m || !m[1].trim()) continue;
    const src = (m[2] ?? "").split(",").map((s) => s.trim());
    const from = /^from @([a-z0-9_-]+)$/i.exec(src[0] ?? "");
    out.push({
      text: m[1].trim(),
      by: from ? from[1] : "you",
      date: src.find((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) ?? null,
      huddle: src.find((s) => /^huddle h_[a-z0-9]+$/i.test(s))?.slice(7) ?? null,
    });
  }
  return out;
}

/** "from @qa-1, 2026-10-10, huddle h_x" or "by you, 2026-10-10". */
export function noteSource(n: HuddleNote): string {
  return [n.by === "you" ? "by you" : `from @${n.by}`, n.date, n.huddle && `huddle ${n.huddle}`].filter(Boolean).join(", ");
}

export function serializeNotes(role: string, scope: NoteScope, notes: HuddleNote[]): string {
  const who = role === ALL_ROLES ? "all roles" : `role ${role}`;
  const head = `# Huddle notes: ${who}, ${scope === "general" ? "all repos" : "this repo"}\n<!-- Newest first. The first ${NOTES_CAP} lines go into new agents' instructions. -->\n\n`;
  return head + notes.map((n) => `- ${noteText(n.text)} <!-- ${noteSource(n)} -->\n`).join("");
}

/** Notes from a request body, checked: text required (one line, NOTE_MAX), source kept as given. */
export function cleanNotes(v: unknown): HuddleNote[] {
  if (!Array.isArray(v)) throw new Error("notes must be a list");
  return v.map((x, i) => {
    const text = noteText(typeof x?.text === "string" ? x.text : "");
    if (!text) throw new Error(`note ${i + 1} is empty`);
    if (text.length > NOTE_MAX) throw new Error(`note ${i + 1} is ${text.length} characters, over the limit of ${NOTE_MAX}`);
    const by = typeof x?.by === "string" && /^[a-z0-9_-]+$/i.test(x.by) ? x.by : "you";
    const date = typeof x?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : null;
    const huddle = typeof x?.huddle === "string" && /^h_[a-z0-9]+$/i.test(x.huddle) ? x.huddle : null;
    return { text, by, date, huddle };
  });
}

/**
 * The "Lessons from past huddles" section of an agent's system prompt: All-roles general and repo notes, then the
 * role's own (when it has a preset), each file's newest NOTES_CAP lines. Empty when there are none.
 */
export function lessonsSection(all: RoleNotes, role: RoleNotes | null, roleName: string | null): string {
  const lines = (ns: HuddleNote[]) => ns.slice(0, NOTES_CAP).map((n) => `- ${noteText(n.text)}`);
  const groups: [string, string[]][] = [
    ["For every role", [...lines(all.general), ...lines(all.repo)]],
    [`For your role (${roleName})`, role ? [...lines(role.general), ...lines(role.repo)] : []],
  ];
  const parts = groups.filter(([, ls]) => ls.length).map(([title, ls]) => `${title}:\n${ls.join("\n")}`);
  if (!parts.length) return "";
  return `# Lessons from past huddles
The user saved these from earlier huddles. Follow them unless the brief or the user says otherwise here.
${parts.join("\n")}`;
}

export interface LessonInput {
  text: string;
  evidence: string;
  scope: NoteScope;
}

/** Lessons from a huddle_status / huddle_post call, checked; throws a readable message. */
export function cleanLessons(v: unknown): LessonInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("lessons must be a list of {text, evidence, scope}");
  if (v.length > MAX_LESSONS) throw new Error(`at most ${MAX_LESSONS} lessons; keep only the ones most worth reusing`);
  return v.map((x, i) => {
    const text = noteText(typeof x?.text === "string" ? x.text : "");
    if (!text) throw new Error(`lesson ${i + 1}: text is required, written as a rule`);
    if (text.length > LESSON_MAX) throw new Error(`lesson ${i + 1} is ${text.length} characters, over the limit of ${LESSON_MAX}; write it as one short rule`);
    const scope = x?.scope ?? "general";
    if (scope !== "general" && scope !== "repo") throw new Error(`lesson ${i + 1}: scope must be general or repo`);
    const evidence = noteText(typeof x?.evidence === "string" ? x.evidence : "").slice(0, LESSON_MAX);
    return { text, evidence, scope };
  });
}
