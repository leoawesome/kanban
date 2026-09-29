import { join } from "node:path";
import { Board } from "./board";
import { Bus } from "./events";
import { createServer } from "./http";
import { startPoller } from "./prpoller";
import { defaultRoot, Store } from "./store";

export async function startDaemon(): Promise<void> {
  const store = new Store(defaultRoot());
  const config = store.config();
  const port = Number(process.env.CKANBAN_PORT) || config.port;
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const webDir = join(import.meta.dir, "..", "..", "web", "dist");
  const server = createServer({ store, bus, board, port, webDir });
  console.log(`ckanban listening on http://localhost:${server.port} (data: ${store.root})`);
  board.recover();
  const stopPoller = startPoller(board, store, config.prPollMinutes);

  const shutdown = async () => {
    console.log("ckanban shutting down");
    stopPoller();
    await board.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
