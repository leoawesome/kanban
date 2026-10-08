import type { Board } from "./board";
import { run } from "./git";
import type { Store } from "./store";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | null;

const CLOSED_MSG = "PR closed without merge.";
const MERGED_MSG = "PR merged.";

export async function ghState(url: string): Promise<PrState> {
  const r = await run(["gh", "pr", "view", url, "--json", "state", "-q", ".state"], process.cwd());
  if (r.code !== 0) return null;
  const s = r.stdout.trim();
  return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : null;
}

/** waits: the card still needs the user, so a merged PR keeps it in Review until that is dealt with. */
export async function checkPr(
  board: Board, store: Store, slug: string, id: string, gh: (url: string) => Promise<PrState> = ghState,
  waits: (slug: string, id: string) => boolean = (s, i) => board.waitsOnUser(s, i),
): Promise<PrState> {
  const t = store.getTicket(slug, id);
  if (!t?.prUrl || t.status !== "review") return null;
  const state = await gh(t.prUrl);
  // The user may have moved the card while gh was in flight.
  const now = store.getTicket(slug, id);
  if (now?.status !== "review" || now.prUrl !== t.prUrl) return state;
  if (state === "MERGED") {
    // The poller sees the merge on every tick while the card waits; say it once.
    if (!store.listComments(slug, id).some((c) => c.author === "ai" && c.text === MERGED_MSG)) store.addComment(slug, id, "ai", MERGED_MSG);
    if (!waits(slug, id)) await board.updateTicket(slug, id, { status: "done" });
  } else if (state === "CLOSED") {
    const last = store.listComments(slug, id).filter((c) => c.author === "ai").at(-1);
    if (last?.text !== CLOSED_MSG) store.addComment(slug, id, "ai", CLOSED_MSG);
  }
  return state;
}

export function startPoller(board: Board, store: Store, minutes: number): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const p of store.listProfiles()) {
        for (const t of store.listTickets(p.slug)) {
          if (t.status === "review" && t.prUrl) await checkPr(board, store, p.slug, t.id).catch(() => {});
        }
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, Math.max(1, minutes) * 60_000);
  tick();
  return () => clearInterval(timer);
}
