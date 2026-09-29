import { expect, test } from "bun:test";
import { extractFinalText, summarizeEvent } from "../src/server/activity";
import { firstRunPrompt, planningCommand, planningPrompt, resumeCommand, resumePrompt } from "../src/server/prompts";
import { parseResult } from "../src/server/result";
import type { Ticket } from "../src/server/types";

const ticket = { id: "t_1", title: "Add dark mode", body: "Use CSS vars." } as Ticket;

test("parseResult last line wins", () => {
  const text = `work\nCKANBAN_RESULT: {"status":"blocked","prUrl":null,"summary":"a"}\nmore\nCKANBAN_RESULT: {"status":"done","prUrl":"https://github.com/x/y/pull/1","summary":"ok"}`;
  expect(parseResult(text)).toEqual({ status: "done", prUrl: "https://github.com/x/y/pull/1", summary: "ok" });
});

test("parseResult tolerates markdown backticks", () => {
  expect(parseResult('`CKANBAN_RESULT: {"status":"done","summary":"s"}`')).toEqual({ status: "done", prUrl: null, summary: "s" });
});

test("parseResult missing or invalid", () => {
  expect(parseResult("no line here")).toBeNull();
  expect(parseResult("CKANBAN_RESULT: {nope")).toBeNull();
  expect(parseResult('CKANBAN_RESULT: {"status":"weird","summary":"x"}')).toBeNull();
});

test("summarizeEvent tool uses and text", () => {
  const tool = (name: string, input: any) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  expect(summarizeEvent(tool("Edit", { file_path: "/repo/src/app.ts" }))).toBe("Edit: src/app.ts");
  expect(summarizeEvent(tool("Bash", { command: "npm test" }))).toBe("Bash: npm test");
  expect(summarizeEvent({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(200) }] } })).toBe("x".repeat(80));
  expect(summarizeEvent({ type: "result", result: "done" })).toBe("Finished");
  expect(summarizeEvent({ type: "system" })).toBeNull();
});

test("extractFinalText prefers result event", () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
    { type: "result", result: "final" },
  ];
  expect(extractFinalText(events)).toBe("final");
  expect(extractFinalText(events.slice(0, 1))).toBe("partial");
  expect(extractFinalText([])).toBe("");
});

test("prompts include ticket and comments", () => {
  const p = firstRunPrompt(ticket, true);
  expect(p).toContain("Add dark mode");
  expect(p).toContain("Use CSS vars.");
  expect(p).toContain("CKANBAN_RESULT:");
  const r = resumePrompt(ticket, [{ id: "1", author: "user", text: "use blue", at: "" }]);
  expect(r).toContain("use blue");
  expect(r).toContain("CKANBAN_RESULT:");
  expect(planningPrompt(ticket, "/x/ticket.md")).toContain("/x/ticket.md");
});

test("commands are shell quoted", () => {
  expect(resumeCommand("/tmp/a b", "u1")).toBe("cd '/tmp/a b' && claude --resume u1");
  expect(planningCommand("/tmp/a", "u1", "it's", false)).toBe(`cd '/tmp/a' && claude --session-id u1 'it'\\''s'`);
  expect(planningCommand("/tmp/a", "u1", "p", true)).toBe(`cd '/tmp/a' && claude --resume u1 'p'`);
});

test("parseResult drops non-https prUrl", () => {
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":"javascript:alert(1)","summary":"s"}')!.prUrl).toBeNull();
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":"http://x/pull/1","summary":"s"}')!.prUrl).toBeNull();
});
