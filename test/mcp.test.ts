import { beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus, type BusEvent } from "../src/server/events";
import { addArgs, maskSecrets, McpManager, parseMcpGet, parseMcpList, scopeOf } from "../src/server/mcp";
import { tempDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude-mcp.ts");

test("parseMcpList: real CLI output", () => {
  const { servers, unparsed } = parseMcpList(readFileSync(join(import.meta.dir, "fixtures", "mcp-list.txt"), "utf8"));
  expect(unparsed).toEqual(["something the parser has never seen"]);
  const by = Object.fromEntries(servers.map((s) => [s.name, s]));
  expect(servers.length).toBe(8);
  expect(by["claude.ai Claude Docs"]).toMatchObject({ target: "https://api.anthropic.com/v1/pages/mcp", transport: "http", status: "connected", message: null });
  expect(by["claude.ai Rippling"]).toMatchObject({ status: "needs_auth", message: "Needs authentication" });
  expect(by["claude.ai Custom MCP (Notion, Google Sheets etc.)"].status).toBe("needs_auth");
  expect(by["zai-mcp-server"]).toMatchObject({ target: "npx -y @z_ai/mcp-server", transport: "stdio", status: "connected" });
  expect(by.posthog).toMatchObject({ transport: "http", target: "https://mcp.posthog.com/mcp?features=llm_analytics&api_key=***" });
  expect(by.events).toMatchObject({ transport: "sse", status: "pending", target: "https://example.com/sse" });
  expect(by["google-sheets"]).toMatchObject({
    status: "failed",
    target: "uvx mcp-google-sheets@latest --token ***",
    message: "Failed to connect — CONNECTION_CLOSED: Connection closed",
  });
});

test("parseMcpList: empty config", () => {
  expect(parseMcpList("No MCP servers configured. Use `claude mcp add` to add a server.\n")).toEqual({ servers: [], unparsed: [] });
});

test("parseMcpGet", () => {
  expect(parseMcpGet("x:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n")).toEqual({ status: "connected", message: null });
  expect(parseMcpGet("x:\n  Status: ✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n")).toEqual({
    status: "failed", message: "Failed to connect — CONNECTION_CLOSED: Connection closed",
  });
  expect(parseMcpGet("garbage")).toBeNull();
});

test("maskSecrets", () => {
  expect(maskSecrets("node s.js --api-key abc --port 3")).toBe("node s.js --api-key *** --port 3");
  expect(maskSecrets("run --token=abc")).toBe("run --token=***");
  expect(maskSecrets("env GITHUB_TOKEN=abc DEBUG=1 x")).toBe("env GITHUB_TOKEN=*** DEBUG=1 x");
  expect(maskSecrets("https://h/x?a=1&auth=zz")).toBe("https://h/x?a=1&auth=***");
});

test("scopeOf", () => {
  const cfg = { user: new Set(["u"]), local: new Set(["l"]), project: new Set(["p"]) };
  expect(scopeOf("claude.ai Gmail", cfg)).toBe("claude.ai");
  expect(scopeOf("u", cfg)).toBe("user");
  expect(scopeOf("l", cfg)).toBe("local");
  expect(scopeOf("p", cfg)).toBe("project");
  expect(scopeOf("plugin:x:y", cfg)).toBe("other");
});

test("addArgs builds argv without a shell and validates input", () => {
  expect(addArgs({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "pkg; rm -rf /"], env: [{ key: "API_KEY", value: "a b" }] }))
    .toEqual(["mcp", "add", "--scope", "user", "--transport", "stdio", "fs", "-e", "API_KEY=a b", "--", "npx", "-y", "pkg; rm -rf /"]);
  expect(addArgs({ name: "s", transport: "http", url: "https://x.dev/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }))
    .toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "s", "https://x.dev/mcp", "-H", "Authorization: Bearer t"]);
  expect(() => addArgs({ name: "--scope", transport: "stdio", command: "x" })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "http", url: "file:///etc/passwd" })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "stdio", command: "" })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "stdio", command: "x", env: [{ key: "A-B", value: "1" }] })).toThrow();
  expect(() => addArgs({ name: "ok", transport: "http", url: "https://x", headers: [{ name: "X", value: "a\nb" }] })).toThrow();
});

let dir: string;
let events: BusEvent[];
let mgr: McpManager;
let argsFile: string;

function setup(servers: Record<string, { target: string; status: string }>, userScope: string[] = []) {
  dir = tempDir("ck-mcp-");
  argsFile = join(dir, "args.log");
  writeFileSync(argsFile, "");
  writeFileSync(join(dir, "state.json"), JSON.stringify(servers));
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ mcpServers: Object.fromEntries(userScope.map((n) => [n, {}])) }));
  process.env.FAKE_MCP_STATE = join(dir, "state.json");
  process.env.FAKE_ARGS_FILE = argsFile;
  delete process.env.FAKE_LOGIN;
  const bus = new Bus();
  events = [];
  bus.on((e) => events.push(e));
  mgr = new McpManager(bus, {
    claudeBin: FAKE, cwd: dir, configFile: join(dir, "claude.json"), seenFile: join(dir, "seen.json"), loginPollMs: 10, loginPollForMs: 2000,
  });
}

const calls = () => readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

beforeEach(() => setup({}));

test("refresh caches the list, scopes it and emits updates", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "✔ Connected" }, "claude.ai Gmail": { target: "https://g", status: "! Needs authentication" } }, ["docs"]);
  const p = mgr.refresh();
  expect(mgr.state().checking).toBe(true);
  await p;
  const s = mgr.state();
  expect(s.checking).toBe(false);
  expect(s.checkedAt).not.toBeNull();
  expect(s.servers.map((x) => [x.name, x.scope, x.status])).toEqual([["docs", "user", "connected"], ["claude.ai Gmail", "claude.ai", "needs_auth"]]);
  // Never-connected claude.ai connector doesn't count toward the badge.
  expect(mgr.attentionCount()).toBe(0);
  expect(events.some((e) => e.type === "mcp.updated")).toBe(true);
});

test("server that worked before and now needs auth counts toward the badge", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "✔ Connected" } }, ["docs"]);
  await mgr.refresh();
  await mgr.logout("docs");
  expect(mgr.state().servers[0].status).toBe("needs_auth");
  expect(mgr.attentionCount()).toBe(1);
  expect(calls().some((c) => c.join(" ") === "mcp logout docs")).toBe(true);
});

test("login runs in background, captures the URL and flips to connected", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "! Needs authentication" } }, ["docs"]);
  await mgr.refresh();
  mgr.login("docs");
  expect(mgr.state().servers[0].login?.state).toBe("waiting");
  expect(() => mgr.login("docs")).toThrow(/already/);
  await until(() => mgr.state().servers[0].login === null);
  expect(mgr.state().servers[0].status).toBe("connected");
  expect(events.some((e) => e.type === "mcp.updated" && e.state.servers[0]?.login?.url === "https://auth.example.com/authorize?x=1")).toBe(true);
});

test("failed login keeps the error", async () => {
  setup({ docs: { target: "https://d.dev/mcp (HTTP)", status: "! Needs authentication" } }, ["docs"]);
  await mgr.refresh();
  process.env.FAKE_LOGIN = "fail";
  mgr.login("docs");
  await until(() => mgr.state().servers[0].login?.state === "failed");
  expect(mgr.state().servers[0].login?.error).toContain("OAuth discovery failed");
});

test("stdio servers can't log in; non-user servers can't be removed", async () => {
  setup({ fs: { target: "npx fs", status: "✔ Connected" }, "claude.ai X": { target: "https://x", status: "✔ Connected" } }, []);
  await mgr.refresh();
  expect(() => mgr.login("fs")).toThrow(/OAuth/);
  await expect(mgr.remove("claude.ai X")).rejects.toThrow(/user-scope/);
  await expect(mgr.remove("fs")).rejects.toThrow(/user-scope/);
  expect(() => mgr.login("nope")).toThrow(/no MCP server/);
});

test("add and remove", async () => {
  await mgr.refresh();
  await mgr.add({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "fs"] });
  await until(() => mgr.state().servers.some((s) => s.name === "fs") && !mgr.state().checking);
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ mcpServers: { fs: {} } }));
  await mgr.refresh();
  expect(mgr.state().servers.find((s) => s.name === "fs")?.scope).toBe("user");
  await expect(mgr.add({ name: "fs", transport: "stdio", command: "x" })).rejects.toThrow(/already exists/);
  await mgr.remove("fs");
  expect(mgr.state().servers.some((s) => s.name === "fs")).toBe(false);
  expect(calls().some((c) => c.join(" ") === "mcp remove fs --scope user")).toBe(true);
});

test("missing claude binary is reported, not thrown", async () => {
  const bus = new Bus();
  const m = new McpManager(bus, { claudeBin: join(tempDir(), "no-such-claude"), cwd: tempDir() });
  await m.refresh();
  expect(m.state().error).toMatch(/not found/i);
  expect(m.state().checking).toBe(false);
});

test("slow CLI times out", async () => {
  const slow = join(tempDir(), "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const m = new McpManager(new Bus(), { claudeBin: slow, cwd: tempDir(), listTimeoutMs: 100 });
  await m.refresh();
  expect(m.state().error).toMatch(/timed out/);
});
