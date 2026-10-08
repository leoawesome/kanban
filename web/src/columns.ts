export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";

/** The ticket fields that place a card on the board (kept apart from api.ts so tests can load this file). */
interface Placed { id: string; status: Status; order: number; slotWait?: { at: string } | null; running?: boolean }

/** claude: dropping a card here makes Claude start (or it is running). */
export const COLUMNS: { id: Status; label: string; hint: string; claude: boolean }[] = [
  { id: "backlog", label: "Backlog", hint: "Park ideas. Nothing runs.", claude: false },
  { id: "planning", label: "Planning", hint: "Claude interviews you and shapes the ticket", claude: true },
  { id: "ready", label: "Queued", hint: "Waits for a free slot, then Claude starts the work on its own", claude: true },
  { id: "in_progress", label: "In Progress", hint: "Claude is working, or queued for a free slot", claude: true },
  { id: "review", label: "Review", hint: "Your turn: check the result", claude: false },
  { id: "done", label: "Done", hint: "Finished", claude: false },
];

/** Columns the board shows: queued (`ready`) tickets sit in In Progress, under the running ones. */
export const BOARD_COLUMNS = COLUMNS.filter((c) => c.id !== "ready");

/** A chat reply waiting for a free run slot: the board shows it in the queue, ahead of Ready tickets. */
export function waitsForSlot(t: Placed): boolean {
  return t.status === "in_progress" && !!t.slotWait && !t.running;
}

/** Tickets per column (in `COLUMNS` order), each column sorted the way the board shows it. */
export function groupByColumn<T extends Placed>(tickets: T[]): Map<Status, T[]> {
  const m = new Map<Status, T[]>(COLUMNS.map((c) => [c.id, []]));
  // Replies waiting for a slot sit in the queue, first in line (oldest first), like the server starts them.
  for (const t of tickets) m.get(waitsForSlot(t) ? "ready" : t.status)?.push(t);
  for (const list of m.values()) {
    list.sort((a, b) => a.slotWait && b.slotWait ? a.slotWait.at.localeCompare(b.slotWait.at)
      : a.slotWait ? -1 : b.slotWait ? 1 : a.order - b.order);
  }
  return m;
}

/** What a board column shows: In Progress also lists the queued (`ready`) tickets, under the running ones. */
const shownIn = <T extends Placed>(byColumn: Map<Status, T[]>, id: Status): T[] =>
  id === "in_progress" ? [...(byColumn.get("in_progress") ?? []), ...(byColumn.get("ready") ?? [])] : byColumn.get(id) ?? [];

/** The board column a ticket's card sits in: queued tickets and replies waiting for a slot show under In Progress. */
export const boardColumnOf = (t: Placed): Status => (waitsForSlot(t) || t.status === "ready" ? "in_progress" : t.status);

/** Ids of the tickets in one board column, top to bottom. */
export const columnOrder = (tickets: Placed[], column: Status): string[] => shownIn(groupByColumn(tickets), column).map((t) => t.id);

/**
 * Prev/next of the open ticket in a column order captured earlier. Tickets deleted or moved out of that column
 * since are skipped; the open ticket keeps its place wherever it went. No wrapping at either end.
 */
export function columnNeighbours(order: string[], column: Status, openId: string, tickets: Placed[]): { prev: string | null; next: string | null } {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const ids = order.filter((id) => {
    const t = byId.get(id);
    return id === openId || (!!t && boardColumnOf(t) === column);
  });
  const at = ids.indexOf(openId);
  return { prev: at > 0 ? ids[at - 1] : null, next: at >= 0 && at < ids.length - 1 ? ids[at + 1] : null };
}
