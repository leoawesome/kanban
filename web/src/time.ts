import { useSyncExternalStore } from "react";

// One shared ticker for every relative time on screen ("5m ago" keeps moving without a reload).
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribeNow(fn: () => void) {
  subs.add(fn);
  timer ??= setInterval(() => {
    now = Date.now();
    subs.forEach((f) => f());
  }, 30_000);
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Re-renders the caller every 30s; use around timeAgo(). */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => now);
}

/** Full local date and time, for tooltips next to relative times. */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function timeUntil(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

/** Plain one-line preview of markdown text (for cards). */
export function plainPreview(md: string, max = 160): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>#|]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
