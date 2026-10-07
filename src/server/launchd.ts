import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UTF8_LOCALE } from "./locale";

export const LABEL = "io.ckanban.daemon";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** programArgs: [bun, cli.ts] from source, or [binary] for the standalone build. "start" is appended. */
export function plistXml(o: { programArgs: string[]; path: string; logFile: string; home: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${o.programArgs.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(o.path)}</string>
    <key>HOME</key>
    <string>${esc(o.home)}</string>
    <key>LANG</key>
    <string>${DEFAULT_UTF8_LOCALE}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(o.logFile)}</string>
</dict>
</plist>
`;
}
