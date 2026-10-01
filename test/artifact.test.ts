import { expect, test } from "bun:test";
import { extractReadHtml, findOutcome, helperCommand, helperEnv, jobPrompts, paneState, tmuxArgs } from "../src/server/artifact";

const L = (o: unknown) => JSON.stringify(o);
const use = (id: string, input: object, name = "Artifact") =>
  L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, extra: object = {}) =>
  L({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] }, ...extra });

const URL = "https://claude.ai/artifact/NJd6w5oY733D1GdTJsrhHB";
const SHELL = `<!doctype html><html><head><meta charset=utf8><style>body{margin:0}</style></head><body>\n`;
const READ = `[Artifact ac85 (version 1) — owned by you; raw HTML follows]
The artifact HTML inside the <cowritten-artifact-html> tag below was not published from this session:
<cowritten-artifact-html>
${SHELL}<title>Page</title>
<h1>Hi</h1>

</body></html>
</cowritten-artifact-html>

IMPORTANT: The artifact HTML inside the <cowritten-artifact-html> tag above was not published from this session.`;

test("helperEnv drops the SDK markers and stops the browser opening", () => {
  const env = helperEnv({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDECODE: "1", HOME: "/h", GONE: undefined });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0" });
});

test("tmuxArgs unsets the markers inside the pane too", () => {
  const a = tmuxArgs({ name: "ckanban-artifact-x", cwd: "/w", bin: "claude", sessionId: "sid", model: "haiku", prompt: "go" });
  expect(a.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "ckanban-artifact-x"]);
  expect(a.slice(a.indexOf("-c"), a.indexOf("-c") + 2)).toEqual(["-c", "/w"]);
  const env = a.indexOf("env");
  expect(a.slice(env, env + 6)).toEqual(["env", "-u", "CLAUDE_CODE_ENTRYPOINT", "-u", "CLAUDECODE", "CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0"]);
  expect(a).toContain("bypassPermissions");
  expect(a.slice(-3)).toEqual(["--session-id", "sid", "go"]);
});

test("jobPrompts: new publish is one turn, republish reads first", () => {
  expect(jobPrompts({ kind: "read", url: URL })).toHaveLength(1);
  const fresh = jobPrompts({ kind: "publish", file: "/o/p.html", title: "My page" });
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toContain("/o/p.html");
  expect(fresh[0]).toContain('"My page"');
  const again = jobPrompts({ kind: "publish", file: "/o/p.html", url: URL });
  expect(again).toHaveLength(2);
  expect(again[0]).toContain('action "read"');
  expect(again[1]).toContain(`passing url ${URL}`);
  // Sent with tmux send-keys, where a newline would submit early.
  for (const p of [...fresh, ...again]) expect(p).not.toContain("\n");
});

test("helperCommand points at the CLI", () => {
  expect(helperCommand()).toContain("cli.ts");
});

test("extractReadHtml strips the viewer shell and ignores tag mentions in prose", () => {
  expect(extractReadHtml(READ)).toBe("<title>Page</title>\n<h1>Hi</h1>\n");
  expect(extractReadHtml("no page here")).toBeNull();
});

test("findOutcome: publish result, skipping quickstart and reads", () => {
  const raw = [
    use("q", { action: "quickstart", intent: "other" }),
    result("q", "Quickstart for a page."),
    use("r", { action: "read", url: URL }),
    result("r", READ),
    use("p", { file_path: "/o/p.html", url: URL }),
    L({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p", content: `Published /o/p.html at ${URL} (Version 3, version id 1)` }] },
      toolUseResult: { url: URL },
    }),
  ].join("\n");
  expect(findOutcome(raw, "publish")).toEqual({ ok: true, kind: "publish", url: URL, text: `Published /o/p.html at ${URL}` });
  expect(findOutcome(raw, "read")).toEqual({ ok: true, kind: "read", html: "<title>Page</title>\n<h1>Hi</h1>\n" });
});

test("findOutcome: still working, refused, and tool missing", () => {
  expect(findOutcome(use("p", { file_path: "/o/p.html" }), "publish")).toBeNull();
  expect(findOutcome("garbage\n", "publish")).toBeNull();

  const refused = [use("p", { file_path: "/o/p.html", url: URL }), result("p", "You hadn't viewed the live version of this artifact, so the publish was refused.")].join("\n");
  expect(findOutcome(refused, "publish")).toEqual({ ok: false, error: "You hadn't viewed the live version of this artifact, so the publish was refused." });

  const missing = [use("p", { file_path: "/o/p.html" }), result("p", "<tool_use_error>Error: No such tool available: Artifact</tool_use_error>", { is_error: true })].join("\n");
  const r = findOutcome(missing, "publish");
  expect(r?.ok).toBe(false);
  expect(!r?.ok && r?.error).toContain("not available in the helper session");

  const errored = [use("p", { file_path: "/o/p.html" }), result("p", "<tool_use_error>file too big</tool_use_error>", { is_error: true })].join("\n");
  expect(findOutcome(errored, "publish")).toEqual({ ok: false, error: "file too big" });
});

test("paneState spots the prompts that would block the helper", () => {
  expect(paneState("Quick safety check\n ❯ No, exit\n   Yes, I trust this folder")).toBe("trust");
  expect(paneState("WARNING: Claude Code running in Bypass Permissions mode\n ❯ No, exit\n   Yes, I accept")).toBe("bypass");
  expect(paneState("⏺ Artifact(read ...)")).toBeNull();
});
