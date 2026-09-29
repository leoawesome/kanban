#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LABEL, PLIST_PATH, plistXml } from "./server/launchd";
import { startDaemon } from "./server/main";
import { defaultRoot, Store } from "./server/store";

const USAGE = `ckanban — kanban board for Claude Code

Usage:
  ckanban dev          Run the server in the foreground
  ckanban start        Same as dev (used by launchd)
  ckanban install      Install and start the launchd background daemon (macOS)
  ckanban restart      Restart the daemon (after pulling or building changes)
  ckanban uninstall    Stop and remove the launchd daemon
  ckanban open         Open the board in your browser
`;

async function sh(cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

function boardUrl(): string {
  const port = Number(process.env.CKANBAN_PORT) || new Store(defaultRoot()).config().port;
  return `http://localhost:${port}`;
}

async function install() {
  const root = defaultRoot();
  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plistXml({
    bunPath: process.execPath,
    cliPath: join(import.meta.dir, "cli.ts"),
    path: process.env.PATH ?? "/usr/bin:/bin",
    logFile: join(root, "daemon.log"),
    home: homedir(),
  }));
  const domain = `gui/${process.getuid!()}`;
  await quiet(["launchctl", "bootout", `${domain}/${LABEL}`]);
  // bootout returns before the old job is gone; bootstrap fails until it is.
  for (let i = 0; i < 50 && (await quiet(["launchctl", "print", `${domain}/${LABEL}`])) === 0; i++) await Bun.sleep(100);
  let code = 1;
  for (let i = 0; i < 5 && code !== 0; i++) {
    code = await quiet(["launchctl", "bootstrap", domain, PLIST_PATH]);
    if (code !== 0) await Bun.sleep(500);
  }
  if (code !== 0) {
    console.error("launchctl bootstrap failed");
    process.exit(code);
  }
  console.log(`Installed ${PLIST_PATH}\nBoard: ${boardUrl()}\nLogs: ${join(root, "daemon.log")}`);
}

async function quiet(cmd: string[]): Promise<number> {
  return Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;
}

async function restart() {
  const code = await sh(["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/${LABEL}`]);
  if (code !== 0) {
    console.error("daemon not installed; run: ckanban install");
    process.exit(code);
  }
  console.log(`Restarted. Board: ${boardUrl()}`);
}

async function uninstall() {
  await sh(["launchctl", "bootout", `gui/${process.getuid!()}/${LABEL}`]);
  rmSync(PLIST_PATH, { force: true });
  console.log("Uninstalled ckanban daemon");
}

const cmd = process.argv[2];
switch (cmd) {
  case "dev":
  case "start":
    await startDaemon();
    break;
  case "install":
    await install();
    break;
  case "restart":
    await restart();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "open":
    await sh(["open", boardUrl()]);
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
