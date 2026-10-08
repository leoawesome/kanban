import { useEffect } from "react";
import { hintStep } from "./keynav";
import { isMac } from "./Shortcuts";

const REVEAL_MS = 300;
const CLASS = "show-hints";

/** Hold ⌘ (Ctrl off Mac) for a moment: every <KeyHint> shows its key. Mount once, in App. */
export function useHintReveal() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      document.body.classList.remove(CLASS);
    };
    const onKey = (e: KeyboardEvent) => {
      const step = hintStep({ type: e.type as "keydown" | "keyup", key: e.key, repeat: e.repeat }, isMac);
      if (step === "hide") hide();
      else if (step === "arm") {
        hide();
        timer = setTimeout(() => document.body.classList.add(CLASS), REVEAL_MS);
      }
    };
    const onVisibility = () => document.hidden && hide();
    // Capture: a handler that stops the key (e.g. Esc layers) must not leave the hints stuck on.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      hide();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

/**
 * Key badge on the control it sits in, shown only while ⌘ is held (see useHintReveal). Write ⌘ in `keys`;
 * off Mac it reads Ctrl+. `inset` keeps the badge inside the control (for ones in a clipping scroll area).
 */
export function KeyHint({ keys, inset, className }: { keys: string; inset?: boolean; className?: string }) {
  return <span className={`key-hint${inset ? " inset" : ""}${className ? ` ${className}` : ""}`} aria-hidden>{isMac ? keys : keys.replace(/⌘/g, "Ctrl+")}</span>;
}
