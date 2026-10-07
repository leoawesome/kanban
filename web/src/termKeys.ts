/** Minimal slice of KeyboardEvent that keyToInput looks at (keeps it testable without a DOM). */
export type KeyLike = {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
};

/**
 * Custom key handling for the embedded terminal, on top of xterm.js.
 * xterm sends a plain `\r` for Shift+Enter, so Claude Code can't tell it from Enter;
 * `ESC CR` is what Claude Code's `/terminal-setup` makes other terminals send for a newline.
 * Returns `undefined` to let xterm handle the key, `null` to swallow it, or the data to send instead.
 */
export function keyToInput(ev: KeyLike): string | null | undefined {
  if (ev.isComposing || ev.key !== "Enter" || !ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return undefined;
  return ev.type === "keydown" ? "\x1b\r" : null;
}
