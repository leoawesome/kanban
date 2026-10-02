/** Grows the textarea with its text (up to `lines` lines, at most 30% of the window), then it scrolls. */
export function autoGrow(el: HTMLTextAreaElement | null, lines = 8) {
  if (!el) return;
  el.style.height = "auto";
  const max = Math.min(window.innerHeight * 0.3, lines * 22 + 8);
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}
