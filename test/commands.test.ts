import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commandText, frontmatter, listCommands, localCommandOutput, parseSlash, rememberInit, slashMessage } from "../src/server/commands";
import { parseSession } from "../src/server/session";
import { commandNote, matchCommands, messageCommand, slashQuery, type SlashCommand } from "../web/src/slashText";
import { tempDir } from "./helpers";

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const skill = (description: string, name?: string) => `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\nBody`;

test("frontmatter: description (quoted, folded) or the first text line", () => {
  expect(frontmatter(skill("Echo it")).description).toBe("Echo it");
  expect(frontmatter(`---\nname: x\ndescription: "Quoted: yes"\n---\n`)).toEqual({ name: "x", description: "Quoted: yes" });
  expect(frontmatter(`---\ndescription: >\n  Folded\n  over lines\nother: 1\n---\n`).description).toBe("Folded over lines");
  expect(frontmatter("# Release the app\n\nSteps…").description).toBe("Release the app");
});

test("listCommands: built-ins, project over user, folders and plugins namespaced", () => {
  const config = tempDir("ck-cfg-");
  const project = tempDir("ck-proj-");
  write(join(config, "skills", "retro", "SKILL.md"), skill("User retro"));
  write(join(config, "skills", "shared", "SKILL.md"), skill("User version"));
  write(join(config, "commands", "git", "sync.md"), "Sync the branch");
  write(join(project, ".claude", "skills", "shared", "SKILL.md"), skill("Project version"));
  write(join(project, ".claude", "commands", "x.md"), skill("Project command"));
  // An enabled user-wide plugin, a disabled one, and one installed for another project.
  const plugin = (name: string) => {
    const dir = join(config, "plugins", "cache", "m", name, "1.0.0");
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    write(join(dir, "skills", "brainstorming", "SKILL.md"), skill(`${name} brainstorming`));
    write(join(dir, "commands", "go.md"), skill(`${name} go`));
    return dir;
  };
  write(join(config, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "superpowers@m": [{ scope: "user", installPath: plugin("superpowers") }],
      "off@m": [{ scope: "user", installPath: plugin("off") }],
      "elsewhere@m": [{ scope: "project", projectPath: "/somewhere/else", installPath: plugin("elsewhere") }],
    },
  }));
  write(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@m": true, "off@m": false, "elsewhere@m": true } }));

  const list = listCommands(project, { configDir: config, fresh: true });
  const by = (n: string) => list.find((c) => c.name === n);
  expect(by("compact")).toMatchObject({ kind: "builtin", source: "claude", local: true });
  expect(by("clear")).toMatchObject({ kind: "builtin", source: "board" });
  expect(by("retro")).toMatchObject({ kind: "skill", source: "user", description: "User retro" });
  expect(by("shared")).toMatchObject({ source: "project", description: "Project version" });
  expect(list.filter((c) => c.name === "shared").length).toBe(1);
  expect(by("x")).toMatchObject({ kind: "command", source: "project" });
  expect(by("git:sync")).toMatchObject({ kind: "command", source: "user", description: "Sync the branch" });
  expect(by("superpowers:brainstorming")).toMatchObject({ kind: "skill", source: "plugin" });
  expect(by("superpowers:go")).toMatchObject({ kind: "command", source: "plugin" });
  expect(by("off:brainstorming")).toBeUndefined();
  expect(by("elsewhere:go")).toBeUndefined();

  // Skills only a run's init event knew (bundled with Claude Code) join the list.
  rememberInit(project, { type: "system", subtype: "init", skills: ["simplify", "retro"], slash_commands: [] });
  const after = listCommands(project, { configDir: config });
  expect(after.find((c) => c.name === "simplify")).toMatchObject({ kind: "skill", source: "claude" });
  expect(after.filter((c) => c.name === "retro")).toHaveLength(1);
});

test("parseSlash / slashMessage: only known commands at the start of the message", () => {
  const list: any[] = [{ name: "brainstorming", kind: "skill", source: "plugin", description: "" }, { name: "compact", kind: "builtin", source: "claude", local: true, description: "" }];
  expect(parseSlash("  /brainstorming plan the import\nflow ")).toEqual({ name: "brainstorming", args: "plan the import\nflow" });
  expect(parseSlash("/Users/leo/x.ts is wrong")).toBeNull();
  expect(parseSlash("see /brainstorming")).toBeNull();
  expect(slashMessage("/brainstorming  plan it ", list)).toMatchObject({ args: "plan it", text: "/brainstorming plan it" });
  expect(slashMessage("/compact", list)).toMatchObject({ text: "/compact", command: { local: true } });
  expect(slashMessage("/notacommand hi", list)).toBeNull();
});

test("commandText / localCommandOutput read Claude Code's command tags", () => {
  expect(commandText("<command-message>shout</command-message>\n<command-name>/shout</command-name>\n<command-args>hi there</command-args>")).toBe("/shout hi there");
  expect(commandText("<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>")).toBe("/compact");
  expect(commandText("plain text")).toBeNull();
  expect(localCommandOutput("<local-command-stdout>Set model to \u001b[1mSonnet\u001b[22m</local-command-stdout>")).toBe("Set model to Sonnet");
  expect(localCommandOutput("hello")).toBeNull();
});

test("parseSession shows commands as typed, their output and compaction", () => {
  const line = (o: object) => JSON.stringify({ timestamp: "2026-10-08T00:00:00Z", ...o });
  const raw = [
    line({ type: "user", uuid: "1", message: { role: "user", content: "<command-message>echoargs</command-message>\n<command-name>/echoargs</command-name>\n<command-args>hello</command-args>" } }),
    line({ type: "user", uuid: "2", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x" }] } }),
    line({ type: "system", uuid: "3", subtype: "compact_boundary", content: "Conversation compacted" }),
    line({ type: "user", uuid: "4", isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } }),
    line({ type: "user", uuid: "5", message: { role: "user", content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>" } }),
    line({ type: "system", uuid: "6", subtype: "local_command", content: "<local-command-stdout>## Context Usage</local-command-stdout>" }),
  ].join("\n");
  expect(parseSession(raw).entries.map((e) => [e.role, e.kind, e.text, e.command ?? e.commandOutput ?? null])).toEqual([
    ["user", "text", "/echoargs hello", "echoargs"],
    ["user", "board", "Conversation compacted", null],
    ["user", "text", "/context", "context"],
    ["assistant", "text", "## Context Usage", true],
  ]);
});

const cmds: SlashCommand[] = [
  { name: "compact", kind: "builtin", source: "claude", description: "" },
  { name: "superpowers:brainstorming", kind: "skill", source: "plugin", description: "" },
  { name: "release", kind: "command", source: "project", description: "" },
  { name: "retro", kind: "skill", source: "user", description: "" },
  { name: "requesting-code-review", kind: "skill", source: "plugin", description: "" },
];

test("slashQuery: only the message's first word, caret inside it", () => {
  expect(slashQuery("/", 1)).toBe("");
  expect(slashQuery("/bra", 4)).toBe("bra");
  expect(slashQuery("/brainstorming plan", 19)).toBeNull();
  expect(slashQuery("hi /bra", 7)).toBeNull();
  expect(slashQuery("/Users/x", 8)).toBeNull();
});

test("matchCommands: grouped skills, commands, built-ins; prefix before fuzzy", () => {
  expect(matchCommands(cmds, "").map((c) => c.name)).toEqual(["requesting-code-review", "retro", "superpowers:brainstorming", "release", "compact"]);
  // Prefix matches only, when there are any: "/co" is compact, not a fuzzy skill above it.
  expect(matchCommands(cmds, "re").map((c) => c.name)).toEqual(["requesting-code-review", "retro", "release"]);
  expect(matchCommands(cmds, "co").map((c) => c.name)).toEqual(["compact"]);
  // Plugin skills match on their own name too.
  expect(matchCommands(cmds, "brain").map((c) => c.name)).toEqual(["superpowers:brainstorming"]);
  // The tightest fuzzy match first.
  expect(matchCommands(cmds, "rtr")[0].name).toBe("retro");
});

test("messageCommand / commandNote: the chip under a sent command", () => {
  expect(messageCommand("/retro last sprint", cmds)?.name).toBe("retro");
  expect(messageCommand("/nope", cmds)).toBeNull();
  expect(commandNote(cmds[3])).toBe("Runs skill · user");
  expect(commandNote(cmds[2])).toBe("Runs command · project");
  expect(commandNote({ name: "clear", kind: "builtin", source: "board", description: "" })).toBe("Board command");
});
