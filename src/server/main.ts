import { existsSync } from "node:fs";
import { join } from "node:path";
import { Board } from "./board";
import { Bus } from "./events";
import { createServer } from "./http";
import { startPoller } from "./prpoller";
import { SessionCache, startSessionWatcher } from "./session";
import { ShellManager } from "./shell";
import { TerminalWatcher } from "./terminals";
import { defaultRoot, Store } from "./store";
import { VERSION } from "./version";
import { WEB_ASSETS } from "./web-assets.gen";

export async function startDaemon(): Promise<void> {
  const store = new Store(defaultRoot());
  const config = store.config();
  const port = Number(process.env.CKANBAN_PORT) || config.port;
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const webDir = join(import.meta.dir, "..", "..", "web", "dist");
  const embedded = Object.keys(WEB_ASSETS).length > 0;
  if (!embedded && !existsSync(join(webDir, "index.html"))) console.warn("web UI not built yet: run `bun run build:web`");
  const sessions = new SessionCache();
  const terminals = new TerminalWatcher(store, bus, sessions);
  const shells = new ShellManager();
  const server = createServer({ store, bus, board, port, webDir, sessions, terminals, shells, assets: WEB_ASSETS });
  console.log(`ckanban v${VERSION} listening on http://localhost:${server.port} (data: ${store.root})`);
  board.recover();
  const stopPoller = startPoller(board, store, config.prPollMinutes);
  const stopWatcher = startSessionWatcher(store, bus, sessions);
  const stopTerminals = terminals.start();

  const shutdown = async () => {
    console.log("ckanban shutting down");
    stopPoller();
    stopWatcher();
    stopTerminals();
    shells.killAll();
    await board.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
