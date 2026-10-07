import { existsSync } from "node:fs";
import { join } from "node:path";
import { Board } from "./board";
import { Bus } from "./events";
import { createServer } from "./http";
import { withUtf8Locale } from "./locale";
import { McpManager } from "./mcp";
import { startPoller } from "./prpoller";
import { Scheduler } from "./scheduler";
import { SessionCache, startSessionWatcher } from "./session";
import { ShellManager } from "./shell";
import { TerminalWatcher } from "./terminals";
import { defaultRoot, Store } from "./store";
import { VERSION } from "./version";
import { WEB_ASSETS } from "./web-assets.gen";
import { detectMissing } from "./worktree-setup";

export async function startDaemon(): Promise<void> {
  // Board runs and other children inherit this; an older launchd plist starts the daemon with no locale.
  Object.assign(process.env, withUtf8Locale(process.env));
  const store = new Store(defaultRoot());
  const config = store.config();
  const port = Number(process.env.CKANBAN_PORT) || config.port;
  const bus = new Bus();
  const sessions = new SessionCache();
  const board = new Board(store, bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", sessionSummary: (id) => sessions.summary(id) });
  const webDir = join(import.meta.dir, "..", "..", "web", "dist");
  const embedded = Object.keys(WEB_ASSETS).length > 0;
  if (!embedded && !existsSync(join(webDir, "index.html"))) console.warn("web UI not built yet: run `bun run build:web`");
  const terminals = new TerminalWatcher(store, bus, sessions);
  const shells = new ShellManager();
  const mcp = new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", seenFile: join(store.root, "mcp-seen.json") });
  const scheduler = new Scheduler(board, store, bus);
  // launchd (KeepAlive) starts the daemon again once it exits.
  const restart = () => board.requestRestart(() => void shutdown());
  const server = createServer({ store, bus, board, port, webDir, sessions, terminals, shells, mcp, scheduler, assets: WEB_ASSETS, restart });
  console.log(`ckanban v${VERSION} listening on http://localhost:${server.port} (data: ${store.root})`);
  board.recover();
  void detectMissing(store, (profile) => bus.emit({ type: "profile.updated", slug: profile.slug, profile }));
  const stopPoller = startPoller(board, store, config.prPollMinutes);
  // After recover(): a missed run's ticket must not be mistaken for an interrupted one.
  const stopScheduler = scheduler.start();
  const stopWatcher = startSessionWatcher(store, bus, sessions);
  const stopTerminals = terminals.start();
  const stopMcp = mcp.start();

  const shutdown = async () => {
    console.log("ckanban shutting down");
    stopPoller();
    stopScheduler();
    stopWatcher();
    stopTerminals();
    shells.killAll();
    stopMcp();
    await board.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
