// Three levels of named settings (teammates, huddle templates): built-ins shipped in code, the user's global ones
// (<home>/<file>.json, every board) and one board's own (profiles/<slug>/<file>.json). The highest level that has a
// name wins: built-in -> global -> board. Deleting at one level falls back to the level below.
// Plain helpers (no file access here; see Store and Huddles).

/** Where a saved entry lives. */
export type Level = "global" | "board";
export type LayerSource = "builtin" | Level;

export interface LayerInfo {
  /** The level whose version is in effect. */
  source: LayerSource;
  /** The version underneath, that Reset (deleting at `source`) falls back to; null: deleting removes the entry. */
  base: LayerSource | null;
  /** The name is a built-in. */
  builtin: boolean;
}

export type Layered<T> = T & LayerInfo;

export const isLevel = (v: unknown): v is Level => v === "global" || v === "board";

/** Built-ins first in their usual order, then every other name in alphabetical order; each at its highest level. */
export function mergeLayers<T extends { name: string }>(builtins: T[], global: T[], board: T[]): Layered<T>[] {
  const levels: [LayerSource, Map<string, T>][] = [
    ["builtin", new Map(builtins.map((x) => [x.name, x]))],
    ["global", new Map(global.map((x) => [x.name, x]))],
    ["board", new Map(board.map((x) => [x.name, x]))],
  ];
  const own = [...new Set([...global, ...board].map((x) => x.name))].filter((n) => !levels[0][1].has(n)).sort((a, b) => a.localeCompare(b));
  return [...builtins.map((x) => x.name), ...own].map((name) => {
    const found = levels.filter(([, m]) => m.has(name));
    const [source, m] = found[found.length - 1];
    return { ...m.get(name)!, source, base: found.length > 1 ? found[found.length - 2][0] : null, builtin: levels[0][1].has(name) };
  });
}

/** The entries a level sits on: built-ins for global, built-ins and global for a board. */
export function lowerLevels<T extends { name: string }>(builtins: T[], global: T[], level: Level): T[] {
  if (level === "global") return builtins;
  const g = new Map(global.map((x) => [x.name, x]));
  return [...builtins.map((b) => g.get(b.name) ?? b), ...global.filter((x) => !builtins.some((b) => b.name === x.name))];
}

/** The level after saving `item`: replaces an entry of the same name, or adds it. */
export const withItem = <T extends { name: string }>(list: T[], item: T): T[] => [...list.filter((x) => x.name !== item.name), item];
