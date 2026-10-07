/** Unsent input saved in localStorage (kept free of React/DOM so it can be unit tested). */

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const DRAFT_PREFIX = "ckanban.draft.";
export const FORM_PREFIX = "ckanban.qform.";
/** Changes tab line comments not sent to Claude yet. */
export const REVIEW_PREFIX = "ckanban.review.";
export const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export const draftKey = (slug: string, ticketId: string) => `${DRAFT_PREFIX}${slug}.${ticketId}`;
export const formKey = (slug: string, ticketId: string, block: string) => `${FORM_PREFIX}${slug}.${ticketId}.${block}`;

/** The browser's localStorage, or null when it's missing or blocked. */
export function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A saved value, or null if there is none or it can't be read. */
export function loadSaved<T>(store: Store | null, key: string): T | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && "v" in parsed ? (parsed.v as T) : null;
  } catch {
    return null;
  }
}

export function save(store: Store | null, key: string, value: unknown, now = Date.now()) {
  try {
    store?.setItem(key, JSON.stringify({ v: value, at: now }));
  } catch {}
}

export function forget(store: Store | null, key: string) {
  try {
    store?.removeItem(key);
  } catch {}
}

/** Drop saved drafts/forms older than `MAX_AGE` (or unreadable) so storage doesn't grow forever. */
export function prune(store: Store | null, now = Date.now()) {
  if (!store) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || ![DRAFT_PREFIX, FORM_PREFIX, REVIEW_PREFIX].some((p) => key.startsWith(p))) continue;
      let at = 0;
      try {
        at = Number(JSON.parse(store.getItem(key) ?? "").at) || 0;
      } catch {}
      if (now - at > MAX_AGE) stale.push(key);
    }
    stale.forEach((k) => store.removeItem(k));
  } catch {}
}
