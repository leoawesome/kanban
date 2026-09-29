import { liveSessionMatch, processCommands } from "./claude";
import type { Bus } from "./events";
import type { SessionCache } from "./session";
import type { Store } from "./store";

/**
 * Tracks which linked tickets have their Claude session open in a terminal right now.
 * One `ps` per poll for all tickets; views read the last result synchronously.
 */
export class TerminalWatcher {
  private open = new Set<string>();

  constructor(
    private store: Store,
    private bus: Bus,
    private sessions: SessionCache,
    private commands: () => Promise<string[]> = processCommands,
  ) {}

  isOpen(slug: string, id: string): boolean {
    return this.open.has(`${slug}/${id}`);
  }

  async poll(): Promise<void> {
    const cmds = await this.commands();
    const next = new Set<string>();
    const changed: [string, string][] = [];
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) {
        if (!t.sessionId || !t.workdir) continue;
        const key = `${p.slug}/${t.id}`;
        const title = this.sessions.summary(t.sessionId)?.title ?? null;
        const live = liveSessionMatch(cmds, { id: t.sessionId, title });
        if (live) next.add(key);
        if (live !== this.open.has(key)) changed.push([p.slug, t.id]);
      }
    }
    for (const k of this.open) if (!next.has(k)) {
      const [slug, id] = k.split("/");
      if (!changed.some(([s, i]) => s === slug && i === id)) changed.push([slug, id]);
    }
    this.open = next;
    for (const [slug, id] of changed) {
      const t = this.store.getTicket(slug, id);
      if (t) this.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
    }
  }

  start(intervalMs = 3000): () => void {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await this.poll();
      } catch (e) {
        console.error("terminal watcher", e);
      } finally {
        busy = false;
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }
}
