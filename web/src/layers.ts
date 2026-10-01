import { useEffect, useRef, type RefObject } from "react";

/**
 * One stack for everything Esc can close (panel, dialogs, menus). Esc only closes the topmost
 * layer, so a confirm on top of a dialog on top of the ticket panel closes one at a time.
 */
type Layer = { close: () => void; skipInInputs: boolean };
const stack: Layer[] = [];
let bound = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || !stack.length) return;
  const top = stack[stack.length - 1];
  if (top.skipInInputs && (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}

export function useLayer(onEscape: () => void, opts: { active?: boolean; skipInInputs?: boolean } = {}) {
  const fn = useRef(onEscape);
  fn.current = onEscape;
  const active = opts.active ?? true;
  useEffect(() => {
    if (!active) return;
    if (!bound) {
      window.addEventListener("keydown", onKey, true);
      bound = true;
    }
    const layer: Layer = { close: () => fn.current(), skipInInputs: !!opts.skipInInputs };
    stack.push(layer);
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active, opts.skipInInputs]);
}

/** True while any panel, dialog or menu is open (board shortcuts stay quiet then). */
export function anyLayerOpen(): boolean {
  return stack.length > 0;
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
}

/**
 * Keeps Tab inside `ref`, focuses it on open (unless something inside already has focus) and gives focus back on close.
 * `focusContainer`: focus the container itself, not its first control (e.g. so Esc still closes the panel).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, focusContainer = false) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!el.contains(document.activeElement)) {
      const first = focusContainer ? null : focusables(el).find((x) => !x.classList.contains("icon-btn"));
      (first ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const f = focusables(el);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);
}
