import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeScript, closeSession, quickChatArgs, sessionProcessUnder, Shell, ShellManager, type ProcRow, type SpawnRequest } from "../src/server/shell";

class FakeShell {
  killed = false;
  sessionId: string | null = null;
  exited = false;
  constructor(public req: SpawnRequest) {}
  kill() {
    this.killed = true;
  }
}

function manager() {
  const spawned: FakeShell[] = [];
  let n = 0;
  const m = new ShellManager((r) => {
    const s = new FakeShell(r);
    if (r.kind === "claude") s.sessionId = r.resume ?? `00000000-0000-0000-0000-00000000000${n++}`;
    spawned.push(s);
    return s as unknown as Shell;
  });
  return { m, spawned };
}

test("claudeScript starts or resumes a known session and quotes the binary", () => {
  expect(claudeScript("claude", "abc")).toBe("exec 'claude' --session-id abc");
  expect(claudeScript("/opt/my bin/claude", "abc", true)).toBe("exec '/opt/my bin/claude' --resume abc");
  expect(claudeScript("it's", "x")).toBe(`exec 'it'\\''s' --session-id x`);
  // Extra args are quoted one by one, for new and resumed chats.
  expect(claudeScript("claude", "abc", false, ["--x", `{"a":"b c"}`, "it's"])).toBe(
    `exec 'claude' --session-id abc '--x' '{"a":"b c"}' 'it'\\''s'`,
  );
  expect(claudeScript("claude", "abc", true, ["--y"])).toBe("exec 'claude' --resume abc '--y'");
});

test("quickChatArgs gives the chat the ckanban MCP server and says which board it is on", () => {
  const args = quickChatArgs({ name: "My Board", slug: "my-board", path: "/w/repo" }, ["/bin/bun", "/src/cli.ts", "mcp"]);
  expect(args[0]).toBe("--mcp-config");
  expect(JSON.parse(args[1])).toEqual({ mcpServers: { ckanban: { command: "/bin/bun", args: ["/src/cli.ts", "mcp"] } } });
  expect(args[2]).toBe("--append-system-prompt");
  expect(args[3]).toContain(`"My Board" (slug: my-board)`);
  expect(args[3]).toContain("/w/repo");
  expect(args[3]).toContain("create_ticket");
  expect(args[3]).toContain("Backlog");
  // Default server command is this ckanban's own `mcp`.
  expect(quickChatArgs({ name: "a", slug: "a", path: "/" }).length).toBe(4);
  expect(JSON.parse(quickChatArgs({ name: "a", slug: "a", path: "/" })[1]).mcpServers.ckanban.args.at(-1)).toBe("mcp");
});

test("only the quick chat gets the profile it belongs to", () => {
  const { m, spawned } = manager();
  m.get("p", "/w", 80, 24, false, "shell", false, "Proj");
  m.get("p", "/w", 80, 24, false, "claude", false, "Proj");
  m.get("p", "/w", 80, 24, true, "claude", true, "Proj");
  expect(spawned.map((s) => s.req.profile)).toEqual([undefined, { name: "Proj", slug: "p" }, { name: "Proj", slug: "p" }]);
});

test("a profile has an independent shell and quick chat", () => {
  const { m, spawned } = manager();
  const shell = m.get("p", "/w", 80, 24, false, "shell");
  const chat = m.get("p", "/w", 80, 24, false, "claude");
  expect(shell).not.toBe(chat);
  expect(spawned.map((s) => s.req.kind)).toEqual(["shell", "claude"]);
  // Reattaching returns the same PTYs.
  expect(m.get("p", "/w")).toBe(shell);
  expect(m.get("p", "/w", 80, 24, false, "claude")).toBe(chat);
  expect(m.current("p", "claude")).toBe(chat);

  // Restarting the chat leaves the shell alone, and starts a new session.
  const next = m.get("p", "/w", 80, 24, true, "claude");
  expect((chat as unknown as FakeShell).killed).toBe(true);
  expect((shell as unknown as FakeShell).killed).toBe(false);
  expect(next.sessionId).not.toBe(chat.sessionId);
  expect(m.current("p")).toBe(shell);

  // Restarting the shell leaves the chat alone.
  m.get("p", "/w", 80, 24, true, "shell");
  expect((next as unknown as FakeShell).killed).toBe(false);
});

test("resume brings a quick chat back on the same session", () => {
  const { m, spawned } = manager();
  const chat = m.get("p", "/w", 80, 24, false, "claude");
  const back = m.get("p", "/w", 80, 24, true, "claude", true);
  expect(back.sessionId).toBe(chat.sessionId);
  expect(spawned[1].req.resume).toBe(chat.sessionId!);
  // Resume never applies to the shell.
  m.get("p", "/w", 80, 24, false, "shell");
  m.get("p", "/w", 80, 24, true, "shell", true);
  expect(spawned.filter((s) => s.req.kind === "shell").every((s) => s.req.resume === undefined)).toBe(true);
});

test("kill stops one kind or all of a profile's PTYs", () => {
  const { m } = manager();
  const shell = m.get("p", "/w");
  const chat = m.get("p", "/w", 80, 24, false, "claude");
  const other = m.get("q", "/v", 80, 24, false, "claude");
  m.kill("p", "claude");
  expect((chat as unknown as FakeShell).killed).toBe(true);
  expect(m.current("p", "claude")).toBeUndefined();
  expect(m.current("p")).toBe(shell);
  m.get("p", "/w", 80, 24, false, "claude");
  m.kill("p");
  expect(m.current("p")).toBeUndefined();
  expect(m.current("p", "claude")).toBeUndefined();
  expect(m.current("q", "claude")).toBe(other);
  m.killAll();
  expect((other as unknown as FakeShell).killed).toBe(true);
  expect(m.current("q", "claude")).toBeUndefined();
});

test("sessionProcessUnder finds the claude process with the session inside the board's PTY only", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const rows: ProcRow[] = [
    { pid: 100, ppid: 1, args: "/bin/zsh -l" },
    { pid: 101, ppid: 100, args: `claude --resume ${id}` },
    { pid: 200, ppid: 1, args: "/bin/zsh -l" },
    { pid: 201, ppid: 200, args: `node /x/claude-code/cli.js --resume ${id}` },
  ];
  expect(sessionProcessUnder(rows, [100], id)?.pid).toBe(101);
  expect(sessionProcessUnder(rows, [200], id)?.pid).toBe(201);
  expect(sessionProcessUnder(rows, [300], id)).toBeNull();
  expect(sessionProcessUnder(rows, [100], "other")).toBeNull();
});

test("closeSession types /exit, and signals only when Claude doesn't leave in time", async () => {
  const typed: string[] = [];
  let alive = true;
  const shell = { write: (d: string) => { typed.push(d); if (d === "\r") alive = false; } };
  const signals: string[] = [];
  expect(await closeSession(shell, 42, { graceMs: 300, isAlive: () => alive, signal: (_p, s) => signals.push(s) })).toBe(true);
  expect(typed.join("")).toBe("\x15/exit\r");
  expect(signals).toEqual([]);

  // Ignores /exit: SIGTERM, then SIGKILL.
  let left = 2;
  const stubborn = await closeSession({ write: () => {} }, 42, { graceMs: 150, isAlive: () => left > 0, signal: (_p, s) => { signals.push(s); if (s === "SIGKILL") left = 0; } });
  expect(stubborn).toBe(true);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test.skipIf(typeof (Bun as any).Terminal !== "function")("findSession finds a session typed into the dock shell and closes it with /exit", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const cli = join(import.meta.dir, "fixtures", "fake-tui", "claude-code", "cli.js");
  const shells = new ShellManager((r) => new Shell(r.cwd, r.cols, r.rows, { shell: "/bin/sh", script: `${process.execPath} ${cli} --resume ${id}` }));
  const s = shells.get("p", tmpdir());
  let out = "";
  s.subscribe((e) => { if (e.type === "data") out += new TextDecoder().decode(e.data); });
  for (let i = 0; i < 50 && !out.includes("ready"); i++) await Bun.sleep(100);
  expect(await shells.findSession("other-session")).toBeNull();
  const owned = await shells.findSession(id);
  expect(owned).not.toBeNull();
  expect(await owned!.close()).toBe(true);
  for (let i = 0; i < 20 && !s.exited; i++) await Bun.sleep(50);
  expect(s.exited).toBe(true);
  shells.killAll();
}, 15000);
