import { useEffect, useState } from "react";
import { browserStore, forget, loadSaved, prune, save } from "./drafts";

prune(browserStore());

/**
 * useState that survives unmounts and reloads via localStorage. `key: null` turns saving off.
 * Empty values (per `isEmpty`) remove the entry; saved values failing `valid` are ignored.
 */
export function usePersistentState<T>(
  key: string | null,
  fallback: () => T,
  isEmpty: (v: T) => boolean,
  valid: (v: T) => boolean = () => true,
) {
  const read = (k: string | null): T => {
    const saved = k ? loadSaved<T>(browserStore(), k) : null;
    return saved !== null && valid(saved) ? saved : fallback();
  };
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  // Switched to another ticket/block while mounted: load its saved value instead.
  let current = state;
  if (state.key !== key) {
    current = { key, value: read(key) };
    setState(current);
  }

  useEffect(() => {
    if (!current.key) return;
    if (isEmpty(current.value)) forget(browserStore(), current.key);
    else save(browserStore(), current.key, current.value);
  }, [current.key, current.value]);

  const setValue = (next: T | ((prev: T) => T)) =>
    setState((s) => ({ key: s.key, value: typeof next === "function" ? (next as (prev: T) => T)(s.value) : next }));
  return [current.value, setValue] as const;
}
