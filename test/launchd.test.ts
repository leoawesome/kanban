import { expect, test } from "bun:test";
import { LABEL, plistXml } from "../src/server/launchd";

test("plistXml", () => {
  const xml = plistXml({ programArgs: ["/opt/bun", "/x/src/cli.ts"], path: "/usr/bin:/a&b", logFile: "/h/daemon.log", home: "/h" });
  expect(LABEL).toBe("io.ckanban.daemon");
  expect(xml).toContain("<string>io.ckanban.daemon</string>");
  expect(xml).toContain("<key>KeepAlive</key>");
  expect(xml).toContain("<string>/usr/bin:/a&amp;b</string>");
  expect(xml).toMatch(/<string>\/opt\/bun<\/string>\s*<string>\/x\/src\/cli.ts<\/string>\s*<string>start<\/string>/);
  expect(xml).toContain("<string>/h/daemon.log</string>");
  expect(xml).toMatch(/<key>LANG<\/key>\s*<string>en_US.UTF-8<\/string>/);
});

test("plistXml for standalone binary", () => {
  const xml = plistXml({ programArgs: ["/Users/me/.local/bin/ckanban"], path: "/usr/bin", logFile: "/l", home: "/h" });
  expect(xml).toMatch(/<string>\/Users\/me\/.local\/bin\/ckanban<\/string>\s*<string>start<\/string>/);
});
