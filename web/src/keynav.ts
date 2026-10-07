/** Keyboard moves between cards: J/K/↑/↓ in a column, H/L/←/→ to the neighbouring non-empty column. */
export type CardDir = "up" | "down" | "left" | "right";
export type CardPos = { col: number; row: number };

/** Key (ignoring modifiers) → direction, or null for keys that don't move between cards. */
export function cardDir(key: string): CardDir | null {
  switch (key) {
    case "j": case "J": case "ArrowDown": return "down";
    case "k": case "K": case "ArrowUp": return "up";
    case "h": case "H": case "ArrowLeft": return "left";
    case "l": case "L": case "ArrowRight": return "right";
    default: return null;
  }
}

/**
 * Next selected card, given the card count of each column. With nothing selected, any move picks the first
 * card of the first non-empty column. Moves clamp at the edges; sideways moves skip empty columns and keep
 * the row (or the last card when the column is shorter). Null when the board has no cards.
 */
export function stepCard(cols: number[], at: CardPos | null, dir: CardDir): CardPos | null {
  const first = cols.findIndex((n) => n > 0);
  if (first < 0) return null;
  if (!at || !cols[at.col]) return { col: first, row: 0 };
  const row = Math.min(at.row, cols[at.col] - 1);
  if (dir === "down") return { col: at.col, row: Math.min(cols[at.col] - 1, row + 1) };
  if (dir === "up") return { col: at.col, row: Math.max(0, row - 1) };
  const step = dir === "right" ? 1 : -1;
  for (let c = at.col + step; c >= 0 && c < cols.length; c += step) {
    if (cols[c] > 0) return { col: c, row: Math.min(row, cols[c] - 1) };
  }
  return { col: at.col, row };
}

/** Board `delta` steps away from the current one, wrapping around; the first board when the current one isn't listed. */
export function stepBoard(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** 1…9 → board index 0…8, by physical key so numpad digits work and the keyboard layout doesn't matter. */
export function boardDigit(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) - 1 : null;
}
