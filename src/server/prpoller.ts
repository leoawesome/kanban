import type { Board } from "./board";
import { run } from "./git";
import type { Store } from "./store";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | null;

const CLOSED_MSG = "PR closed without merge.";

export async function ghState(url: string): Promise<PrState> {
  const r = await run(["gh", "pr", "view", url, "--json", "state", "-q", ".state"], process.cwd());
  if (r.code !== 0) return null;
  const s = r.stdout.trim();
  return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : null;
}

export async function checkPr(
  board: Board, store: Store, slug: string, id: string, gh: (url: string) => Promise<PrState> = ghState,
): Promise<PrState> {
  const t = store.getTicket(slug, id);
  if (!t?.prUrl || t.status !== "review") return null;
  const state = await gh(t.prUrl);
  if (state === "MERGED") {
    store.addComment(slug, id, "ai", "PR merged.");
    await board.updateTicket(slug, id, { status: "done" });
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
