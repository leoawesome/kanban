// Plain helpers for the Team tab (teammates and templates), kept apart from the components so tests can import them.
import { timeAgo } from "./time";

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "5h ago · 9 huddles", or "never used". */
export function usageText(u: { huddles: number; lastUsed: string | null } | undefined): string {
  return u?.huddles ? `${u.lastUsed ? timeAgo(u.lastUsed) : "used"} · ${plural(u.huddles, "huddle")}` : "never used";
}

/** A scope chip, only for the exceptions (all boards is the default). */
export function scopeChip(x: { source: string; base: string | null; builtin: boolean }): { text: string; tone: string } | null {
  if (x.source === "board") return x.base ? { text: "changed on this board", tone: "warn" } : { text: "this board only", tone: "" };
  if (x.source === "global" && x.builtin) return { text: "changed", tone: "" };
  return null;
}

/** Where Reset goes back to. */
export const resetTitle = (x: { base: string | null }) => `Back to the ${x.base === "builtin" ? "built-in" : "all-boards"} version`;
