import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  assertCanChange, BoardClient, ClientError, DAEMON_DOWN, mainCheckout, parseStatus, resolveProfile, runProfile, type ProfileInfo,
} from "../src/client";
import { callTool, handleMessage, TOOLS, type ToolContext } from "../src/mcp-server";
import { AgentRegistry, readCodexServer, removeCodexServer, setCodexServer } from "../src/server/agents";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { agentsFrom, bodyFrom, parseArgs, ticketCommand } from "../src/ticket-cli";
import { makeRepo, tempDir } from "./helpers";

const prof = (slug: string, path: string): ProfileInfo => ({ name: slug, slug, path, baseBranch: "main" });

// --- profile matching ---------------------------------------------------------------------------

test("resolveProfile: deepest folder containing cwd wins", () => {
  const root = tempDir();
  mkdirSync(join(root, "mono/apps/web/src"), { recursive: true });
  const ps = [prof("mono", join(root, "mono")), prof("web", join(root, "mono/apps/web")), prof("other", join(root, "other"))];
  expect(resolveProfile(ps, { cwd: join(root, "mono/apps/web/src"), main: () => null }).slug).toBe("web");
  expect(resolveProfile(ps, { cwd: join(root, "mono/apps"), main: () => null }).slug).toBe("mono");
  expect(resolveProfile(ps, { cwd: join(root, "mono"), main: () => null }).slug).toBe("mono");
});

test("resolveProfile: prefix of a sibling folder name doesn't match", () => {
  const root = tempDir();
  mkdirSync(join(root, "app-2"), { recursive: true });
  expect(() => resolveProfile([prof("app", join(root, "app"))], { cwd: join(root, "app-2"), main: () => null })).toThrow(ClientError);
});

test("resolveProfile: follows symlinks", () => {
  const root = tempDir();
  mkdirSync(join(root, "real/sub"), { recursive: true });
  symlinkSync(join(root, "real"), join(root, "link"));
  expect(resolveProfile([prof("r", join(root, "link"))], { cwd: join(root, "real/sub"), main: () => null }).slug).toBe("r");
});

test("resolveProfile: a worktree outside the repo resolves to its main checkout", () => {
  const root = tempDir();
  mkdirSync(join(root, "repo"), { recursive: true });
  mkdirSync(join(root, ".ckanban-worktrees/repo/t_1"), { recursive: true });
  const p = resolveProfile([prof("repo", join(root, "repo"))], { cwd: join(root, ".ckanban-worktrees/repo/t_1"), main: () => join(root, "repo") });
  expect(p.slug).toBe("repo");
});

test("mainCheckout finds the main repo from a real git worktree", async () => {
  const repo = await makeRepo();
  const wt = join(tempDir(), "wt");
  Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "x", wt], { cwd: repo });
  expect(mainCheckout(wt)).toBe(repo);
  expect(mainCheckout(tempDir())).toBeNull();
});

test("resolveProfile: explicit slug or name wins; no match lists profiles", () => {
  const ps = [prof("a", "/nowhere/a"), { ...prof("b", "/nowhere/b"), name: "Bee Board" }];
  expect(resolveProfile(ps, { explicit: "a", cwd: "/" }).slug).toBe("a");
  expect(resolveProfile(ps, { explicit: "bee board", cwd: "/" }).slug).toBe("b");
  expect(() => resolveProfile(ps, { explicit: "zzz", cwd: "/" })).toThrow(/no profile "zzz"/);
  try {
    resolveProfile(ps, { cwd: tempDir(), main: () => null });
    throw new Error("expected a throw");
  } catch (e) {
    expect((e as Error).message).toContain("no profile matches");
    expect((e as Error).message).toContain("a  (a, /nowhere/a)");
    expect((e as Error).message).toContain("b  (Bee Board, /nowhere/b)");
  }
});

test("runProfile and assertCanChange read CKANBAN_TICKET", () => {
  expect(runProfile({ CKANBAN_TICKET: "kanban/t_1" })).toBe("kanban");
  expect(runProfile({})).toBeNull();
  expect(() => assertCanChange({})).not.toThrow();
  expect(() => assertCanChange({ CKANBAN_TICKET: "kanban/t_1" })).toThrow(/inside a board run/);
});

test("parseStatus accepts friendly spellings", () => {
  expect(parseStatus("In Progress")).toBe("in_progress");
  expect(parseStatus("in-progress")).toBe("in_progress");
  expect(parseStatus("READY")).toBe("ready");
  expect(() => parseStatus("doing")).toThrow(/invalid status/);
});

test("client reports a stopped daemon clearly", async () => {
  const c = new BoardClient(1, async () => { throw new TypeError("fetch failed"); });
  await expect(c.listProfiles()).rejects.toThrow(DAEMON_DOWN);
});

// --- CLI argument parsing -----------------------------------------------------------------------

test("parseArgs: flags, = form, booleans, positionals and --", () => {
  const p = parseArgs(["create", "--title", "Fix it", "--json", "--mode=auto", "x", "--", "--not-a-flag"]);
  expect(p.positional).toEqual(["create", "x", "--not-a-flag"]);
  expect(p.flags).toEqual({ title: "Fix it", json: true, mode: "auto" });
  expect(() => parseArgs(["--title"])).toThrow(/needs a value/);
});

test("bodyFrom: --body, --body-file, stdin, not both", () => {
  const f = join(tempDir(), "b.md");
  writeFileSync(f, "from file");
  expect(bodyFrom(parseArgs(["--body", "inline"]))).toBe("inline");
  expect(bodyFrom(parseArgs(["--body-file", f]))).toBe("from file");
  expect(bodyFrom(parseArgs(["--body", "-"]), () => "piped")).toBe("piped");
  expect(bodyFrom(parseArgs([]))).toBeUndefined();
  expect(() => bodyFrom(parseArgs(["--body", "a", "--body-file", f]))).toThrow(/not both/);
});

test("agentsFrom defaults to both", () => {
  expect(agentsFrom(parseArgs([]))).toEqual(["claude", "codex"]);
  expect(agentsFrom(parseArgs(["--codex"]))).toEqual(["codex"]);
});

// --- MCP tool handlers (client mocked) ----------------------------------------------------------

function fakeClient() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ticket = (over: object = {}) => ({
    id: "t_1", title: "Dark mode", status: "backlog", mode: "interview", body: "b", outcome: null, prUrl: null, branch: null,
    lastActivity: null, error: null, createdAt: "", updatedAt: "", running: false, ...over,
  });
  const rec = (fn: string, result: (...a: any[]) => unknown) => async (...args: unknown[]) => {
    calls.push({ fn, args });
    return result(...args);
  };
  const client = {
    listProfiles: rec("listProfiles", () => [prof("kanban", "/repos/kanban"), prof("site", "/repos/site")]),
    listTickets: rec("listTickets", () => [ticket(), ticket({ id: "t_2", title: "Ship", status: "ready" })]),
    getTicket: rec("getTicket", () => ticket()),
    listComments: rec("listComments", () => [{ id: "c", author: "user", text: "pls", at: "now" }]),
    createTicket: rec("createTicket", (_s, input) => ticket(input)),
    updateTicket: rec("updateTicket", (_s, _id, patch) => ticket(patch)),
    deleteTicket: rec("deleteTicket", () => undefined),
    chat: rec("chat", () => ticket({ running: true })),
    stop: rec("stop", () => ({ stopped: true })),
    comment: rec("comment", () => ({ id: "c2", author: "user", text: "x", at: "" })),
  };
  return { client: client as unknown as ToolContext["client"], calls };
}

const ctxWith = (env: Record<string, string> = {}, cwd = "/repos/kanban/src") => {
  const f = fakeClient();
  return { ...f, ctx: { client: f.client, cwd, env, main: () => null } as ToolContext };
};

test("create_ticket defaults to backlog + interview and the cwd's board", async () => {
  const { ctx, calls } = ctxWith();
  const r = await callTool("create_ticket", { title: " Dark mode ", body: "## Goal" }, ctx);
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain("Created t_1 on board kanban in backlog (interview mode)");
  expect(calls.at(-1)).toEqual({ fn: "createTicket", args: ["kanban", { title: "Dark mode", body: "## Goal", status: "backlog", mode: "interview" }] });
});

test("tools take an explicit profile and validate input", async () => {
  const { ctx, calls } = ctxWith({}, "/elsewhere");
  await callTool("move_ticket", { profile: "site", id: "t_1", status: "Ready" }, ctx);
  expect(calls.at(-1)).toEqual({ fn: "updateTicket", args: ["site", "t_1", { status: "ready" }] });
  const noBoard = await callTool("list_tickets", {}, ctx);
  expect(noBoard.isError).toBe(true);
  expect(noBoard.content[0].text).toContain("no profile matches");
  expect((await callTool("update_ticket", { profile: "site", id: "t_1" }, ctx)).content[0].text).toContain("nothing to change");
  expect((await callTool("create_ticket", { profile: "site" }, ctx)).content[0].text).toBe("title is required");
  expect((await callTool("nope", {}, ctx)).isError).toBe(true);
});

test("read tools format tickets", async () => {
  const { ctx } = ctxWith();
  const list = await callTool("list_tickets", { status: "ready" }, ctx);
  expect(list.content[0].text).toBe("Board kanban:\nt_2  [ready]  Ship");
  const one = await callTool("get_ticket", { id: "t_1" }, ctx);
  expect(one.content[0].text).toContain("Dark mode");
  expect(one.content[0].text).toContain("- user (now): pls");
});

test("chat, stop, comment, delete call the API", async () => {
  const { ctx, calls } = ctxWith();
  expect((await callTool("chat_ticket", { id: "t_1", message: "go" }, ctx)).content[0].text).toContain("Claude is working on it");
  expect((await callTool("stop_ticket", { id: "t_1" }, ctx)).content[0].text).toBe("Stopped the run on t_1.");
  await callTool("comment_ticket", { id: "t_1", text: "note" }, ctx);
  await callTool("delete_ticket", { id: "t_1" }, ctx);
  expect(calls.filter((c) => c.fn !== "listProfiles").map((c) => c.fn)).toEqual(["chat", "stop", "comment", "deleteTicket"]);
});

test("inside a board run, changing tools are refused and read tools work", async () => {
  const { ctx, calls } = ctxWith({ CKANBAN_TICKET: "site/t_9" }, "/elsewhere");
  for (const tool of TOOLS.filter((t) => t.changes)) {
    const r = await callTool(tool.name, { id: "t_1", title: "x", status: "ready", message: "m", text: "t" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("inside a board run");
  }
  expect(calls.length).toBe(0);
  // Defaults to the run's own board even though cwd matches nothing.
  const r = await callTool("list_tickets", {}, ctx);
  expect(r.isError).toBeUndefined();
  expect(calls.find((c) => c.fn === "listTickets")?.args).toEqual(["site"]);
});

test("every tool advertises a profile argument; change tools are flagged", () => {
  for (const t of TOOLS.filter((t) => t.name !== "list_profiles")) expect(t.inputSchema.properties.profile).toBeDefined();
  expect(TOOLS.filter((t) => !t.changes).map((t) => t.name).sort()).toEqual(["get_ticket", "list_profiles", "list_tickets"]);
});

test("JSON-RPC: initialize, tools/list, tools/call, notifications, unknown methods", async () => {
  const { ctx } = ctxWith();
  const init: any = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, ctx);
  expect(init.result.protocolVersion).toBe("2025-03-26");
  expect(init.result.capabilities.tools).toBeDefined();
  const future: any = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, ctx);
  expect(future.result.protocolVersion).toBe("2025-06-18");
  expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
  const list: any = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx);
  expect(list.result.tools.map((t: any) => t.name)).toContain("create_ticket");
  expect(list.result.tools[0].changes).toBeUndefined();
  const call: any = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_profiles", arguments: {} } }, ctx);
  expect(call.result.content[0].text).toContain("kanban  (kanban, /repos/kanban)");
  const bad: any = await handleMessage({ jsonrpc: "2.0", id: 5, method: "resources/list" }, ctx);
  expect(bad.error.code).toBe(-32601);
});

test("`ckanban mcp` speaks MCP over stdio", async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src/cli.ts"), "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, CKANBAN_PORT: "1" },
  });
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_profiles", arguments: {} } },
  ];
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  p.stdin.end();
  const out = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(await p.exited).toBe(0);
  const byId = new Map(out.map((m: any) => [m.id, m]));
  expect(byId.get(1).result.serverInfo.name).toBe("ckanban");
  expect(byId.get(2).result.tools.length).toBe(TOOLS.length);
  expect(byId.get(3).result.isError).toBe(true);
  expect(byId.get(3).result.content[0].text).toBe(DAEMON_DOWN);
});

// --- CLI against a real server ------------------------------------------------------------------

let server: ReturnType<typeof createServer>;
let repo: string;
beforeAll(async () => {
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), agents: new AgentRegistry({ claudeBin: "/bin/false" }) });
  repo = await makeRepo();
  mkdirSync(join(repo, "src"));
  await fetch(`http://127.0.0.1:${server.port}/api/profiles`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Repo", path: repo }),
  });
});
afterAll(() => server.stop(true));

async function cli(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const lines: string[] = [];
  await ticketCommand(argv, { out: (s) => lines.push(s), client: new BoardClient(server.port!), cwd: opts.cwd ?? join(repo, "src"), env: opts.env ?? {} });
  return lines.join("\n");
}

test("CLI: create from inside the repo lands in backlog/interview; list, show, update, comment, delete", async () => {
  const created = JSON.parse(await cli(["create", "--title", "Add dark mode", "--body", "## Goal\nDark", "--json"]));
  expect(created).toMatchObject({ title: "Add dark mode", status: "backlog", mode: "interview", body: "## Goal\nDark" });
  expect(await cli(["list"])).toContain(`${created.id}  [backlog]  Add dark mode`);
  await cli(["update", created.id, "--title", "Dark mode", "--mode", "auto"]);
  await cli(["comment", created.id, "looks", "good"]);
  const shown = await cli(["show", created.id]);
  expect(shown).toContain("Dark mode");
  expect(shown).toContain("mode: auto");
  expect(shown).toContain("looks good");
  expect(await cli(["delete", created.id])).toBe(`Deleted ${created.id}.`);
  expect(await cli(["list"])).toBe("No tickets on repo.");
});

test("CLI: outside every profile it fails listing profiles; --profile overrides", async () => {
  await expect(cli(["list"], { cwd: tempDir() })).rejects.toThrow(/no profile matches[\s\S]*repo  \(Repo/);
  expect(await cli(["create", "Quick one", "--profile", "repo"], { cwd: tempDir() })).toContain("Created");
});

test("CLI: changing commands refused inside a board run", async () => {
  await expect(cli(["create", "--title", "x"], { env: { CKANBAN_TICKET: "repo/t_1" } })).rejects.toThrow(/inside a board run/);
  expect(await cli(["list"], { env: { CKANBAN_TICKET: "repo/t_1" } })).toContain("Quick one");
});

test("agents API reports status and registers Codex", async () => {
  const home = tempDir();
  const codexConfig = join(home, ".codex/config.toml");
  const s2 = createServer({
    store: new Store(tempDir("ck-home-")), bus: new Bus(), board: new Board(new Store(tempDir()), new Bus(), { claudeBin: "/bin/false" }),
    port: 0, webDir: tempDir(),
    agents: new AgentRegistry({ claudeBin: "/bin/false", codexBin: "no-such-codex", claudeConfig: join(home, ".claude.json"), codexConfig, serverArgv: ["/bin/ck", "mcp"] }),
  });
  try {
    const base = `http://127.0.0.1:${s2.port}/api/agents`;
    const before: any = await (await fetch(base)).json();
    expect(before.map((a: any) => [a.id, a.installed])).toEqual([["claude", false], ["codex", false]]);
    const r = await fetch(`${base}/codex/install`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const after: any = await r.json();
    expect(after[1]).toMatchObject({ installed: true, current: true, command: "/bin/ck mcp" });
    expect(readFileSync(codexConfig, "utf8")).toContain("[mcp_servers.ckanban]");
    expect((await fetch(`${base}/nope/install`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  } finally {
    s2.stop(true);
  }
});

// --- Codex config.toml --------------------------------------------------------------------------

const EXISTING = `model = "o3"

[mcp_servers.github]
command = "npx"
args = ["-y", "gh"]

[mcp_servers.ckanban]
command = "/old/ckanban"
args = ["mcp"]

[mcp_servers.ckanban.env]
X = "1"

[profiles.fast]
model = "o4-mini"
`;

test("setCodexServer replaces our table (and sub-tables) and keeps the rest", () => {
  const out = setCodexServer(EXISTING, ["/usr/local/bin/bun", "/src/cli.ts", "mcp"]);
  expect(out).toContain(`[mcp_servers.github]\ncommand = "npx"`);
  expect(out).toContain(`[profiles.fast]\nmodel = "o4-mini"`);
  expect(out).not.toContain("/old/ckanban");
  expect(out).not.toContain("ckanban.env");
  expect(out.match(/\[mcp_servers\.ckanban\]/g)?.length).toBe(1);
  expect(readCodexServer(out)).toEqual(["/usr/local/bin/bun", "/src/cli.ts", "mcp"]);
});

test("setCodexServer is idempotent and works on an empty file", () => {
  const once = setCodexServer("", ["/bin/ck", "mcp"]);
  expect(once).toBe(`[mcp_servers.ckanban]\ncommand = "/bin/ck"\nargs = ["mcp"]\n`);
  expect(setCodexServer(once, ["/bin/ck", "mcp"])).toBe(once);
  const twice = setCodexServer(setCodexServer(EXISTING, ["/bin/ck", "mcp"]), ["/bin/ck", "mcp"]);
  expect(twice).toBe(setCodexServer(EXISTING, ["/bin/ck", "mcp"]));
});

test("readCodexServer handles quoted keys, single quotes and absence", () => {
  expect(readCodexServer(`[mcp_servers."ckanban"]\ncommand = '/a b/ck'\nargs = []`)).toEqual(["/a b/ck"]);
  expect(readCodexServer(EXISTING.replace(/\[mcp_servers\.ckanban\][\s\S]*?(?=\[profiles)/, ""))).toBeNull();
  expect(removeCodexServer(EXISTING)).not.toContain("ckanban");
});

test("AgentRegistry: Codex install/uninstall keeps file mode and other entries; Claude reads ~/.claude.json", async () => {
  const home = tempDir();
  const codexConfig = join(home, ".codex/config.toml");
  mkdirSync(join(home, ".codex"));
  writeFileSync(codexConfig, EXISTING);
  chmodSync(codexConfig, 0o600);
  const claudeConfig = join(home, ".claude.json");
  writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { ckanban: { type: "stdio", command: "/bin/ck", args: ["mcp"] } } }));
  const reg = new AgentRegistry({ claudeBin: "/bin/false", codexBin: "no-such-codex", claudeConfig, codexConfig, serverArgv: ["/bin/ck", "mcp"] });

  const [claude, codex] = await reg.status();
  expect(claude).toMatchObject({ installed: true, current: true });
  expect(codex).toMatchObject({ installed: true, current: false, command: "/old/ckanban mcp", available: true });

  await reg.install("codex");
  expect(readCodexServer(readFileSync(codexConfig, "utf8"))).toEqual(["/bin/ck", "mcp"]);
  expect(statSync(codexConfig).mode & 0o777).toBe(0o600);
  // Claude already current: no `claude mcp` call (the bin is /bin/false, which would fail).
  await reg.install("claude");

  await reg.uninstall("codex");
  const text = readFileSync(codexConfig, "utf8");
  expect(readCodexServer(text)).toBeNull();
  expect(text).toContain("[mcp_servers.github]");
  await expect(new AgentRegistry({ claudeBin: "/usr/bin/false", claudeConfig: join(home, "none.json"), serverArgv: ["/bin/ck", "mcp"] }).install("claude"))
    .rejects.toThrow(/claude mcp add failed/);
});
