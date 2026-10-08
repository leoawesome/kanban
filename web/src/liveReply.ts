/** The fields used here of api.ts's SessionEntry (kept DOM-free so the root typecheck and tests can import it). */
interface Entry { role: "user" | "assistant"; kind: string; text: string; peer?: unknown }

/** What to show of a half-written reply: hide board blocks (questions/proposal JSON) and the result line. */
export function liveView(text: string): { text: string; preparing: string | null } {
  const cut = text.indexOf("<ckanban-");
  const visible = (cut >= 0 ? text.slice(0, cut) : text).replace(/^CKANBAN_RESULT.*$/gm, "").trim();
  if (cut < 0) return { text: visible, preparing: null };
  const rest = text.slice(cut);
  return {
    text: visible,
    preparing: rest.startsWith("<ckanban-questions") ? "Preparing questions…"
      : rest.startsWith("<ckanban-mockup") ? "Drawing mockup…"
      : rest.startsWith("<ckanban-tickets") ? "Preparing tickets…"
      : rest.startsWith("<ckanban-ticket") ? "Preparing ticket proposal…" : null,
  };
}

/** Reply text compared loosely: no result line, whitespace collapsed. */
export const flat = (s: string) => s.replace(/^.*CKANBAN_RESULT.*$/gm, "").replace(/\s+/g, " ").trim();

/** A finished live reply kept on screen until the conversation shows its saved copy. */
export type Handoff = { text: string; flat: string; at: number; count: number };

export function handoff(final: string, count: number, at = Date.now()): Handoff {
  return { text: final, flat: flat(liveView(final).text), at, count };
}

/** Whether the loaded entries contain the saved copy of a finished live reply. */
export function saved(entries: Entry[], h: Handoff): boolean {
  // Only board blocks (questions, proposal…): nothing to compare, so wait for any new entry.
  if (!h.flat) return entries.length > h.count;
  const recent = entries.filter((e) => e.role === "assistant" && e.kind === "text" && !e.peer).slice(-30);
  // Joined by line breaks: with a space, one reply's result line would run into the next reply's first line
  // and flat() would drop both, so a reply after a result line never matched.
  return flat(recent.map((e) => e.text).join("\n")).includes(h.flat);
}
