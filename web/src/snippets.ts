import { useEffect, useState } from "react";
import { api, onReconnect, subscribe, type Snippet } from "./api";

// One fetch per board, shared by every composer on screen; refetched when snippets change anywhere.
const cache = new Map<string, Snippet[]>();
const watchers = new Set<() => void>();
let wired = false;

function refetchAll() {
  for (const slug of [...cache.keys()]) load(slug);
}

function load(slug: string): Promise<void> {
  return api.snippets(slug).then((list) => {
    cache.set(slug, list);
    for (const fn of watchers) fn();
  }).catch(() => {});
}

/** Refetch now (after a save, so the list already has it when the caller selects it). */
export const reloadSnippets = load;

/** Global snippets plus this board's. null while loading. */
export function useSnippets(slug: string): Snippet[] | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!wired) {
      wired = true;
      subscribe((e) => e.type === "snippets.updated" && refetchAll());
      onReconnect(refetchAll);
    }
    const fn = () => bump((n) => n + 1);
    watchers.add(fn);
    if (!cache.has(slug)) load(slug);
    return () => { watchers.delete(fn); };
  }, [slug]);
  return cache.get(slug) ?? null;
}
