import { expect, test } from "bun:test";
import { claudeScript, quickChatArgs, Shell, ShellManager, type SpawnRequest } from "../src/server/shell";

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
