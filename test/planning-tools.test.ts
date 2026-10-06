import { expect, test } from "bun:test";
import { callTool, proposalError, questionsError, ticketsError, type ToolContext } from "../src/mcp-server";

const opt = (label: string, recommended?: boolean) => ({ label, ...(recommended ? { recommended } : {}) });
const q = (options = [opt("Red", true), opt("Blue")], extra = {}) => ({ question: "Color?", options, ...extra });

test("ask_questions: 1-5 questions, 2-4 labelled options, exactly one recommended", () => {
  expect(questionsError({ questions: [q()] })).toBeNull();
  expect(questionsError({ questions: [q(), q([opt("a"), opt("b", true), opt("c"), opt("d")], { multiSelect: true })] })).toBeNull();
  expect(questionsError({ questions: [] })).toContain("1-5 questions");
  expect(questionsError({ questions: Array(6).fill(q()) })).toContain("1-5 questions");
  expect(questionsError({})).toContain("1-5 questions");
  expect(questionsError({ questions: [{ ...q(), question: " " }] })).toBe("question 1: question text is required");
  expect(questionsError({ questions: [q([opt("Red", true)])] })).toContain("2-4 options");
  expect(questionsError({ questions: [q([opt("a", true), opt("b"), opt("c"), opt("d"), opt("e")])] })).toContain("2-4 options");
  expect(questionsError({ questions: [q([opt("a", true), opt("")])] })).toContain("needs a label");
  expect(questionsError({ questions: [q(), q([opt("a", true), opt("b", true)])] })).toBe("question 2: mark exactly one option recommended (found 2)");
  expect(questionsError({ questions: [q([opt("a"), opt("b")])] })).toContain("found 0");
  expect(questionsError({ questions: [q(undefined, { multiSelect: "yes" })] })).toContain("multiSelect");
});

test("propose_ticket: non-empty title under 80 characters, description required", () => {
  expect(proposalError({ title: "Fix the chat", description: "## Goal\n..." })).toBeNull();
  expect(proposalError({ title: " ", description: "x" })).toBe("title is required");
  expect(proposalError({ title: "x".repeat(79), description: "x" })).toBeNull();
  expect(proposalError({ title: "x".repeat(80), description: "x" })).toContain("under 80 characters");
  expect(proposalError({ title: "Fix" })).toBe("description is required");
});

test("propose_tickets: unique keys, valid titles, every dependsOn key exists", () => {
  const t = (key: string, dependsOn?: string[]) => ({ key, title: `Do ${key}`, description: "## Goal", ...(dependsOn ? { dependsOn } : {}) });
  expect(ticketsError({ tickets: [t("api"), t("ui", ["api"])] })).toBeNull();
  expect(ticketsError({ tickets: [] })).toContain("non-empty");
  expect(ticketsError({ tickets: [t("api"), t("api")] })).toContain('key "api" is used twice');
  expect(ticketsError({ tickets: [{ ...t("api"), key: "" }] })).toBe("ticket 1: key is required");
  expect(ticketsError({ tickets: [{ ...t("api"), title: "x".repeat(90) }] })).toContain("ticket 1: title must be under 80");
  expect(ticketsError({ tickets: [{ ...t("api"), description: "" }] })).toBe("ticket 1: description is required");
  expect(ticketsError({ tickets: [t("api"), t("ui", ["db"])] })).toContain('dependsOn "db" is not the key');
  expect(ticketsError({ tickets: [t("api", ["api"])] })).toContain('dependsOn "api"');
  expect(ticketsError({ tickets: [{ ...t("api"), dependsOn: "x" }] })).toContain("list of keys");
});

test("the tools return an error Claude can fix, or tell it to wait; nothing touches the board", async () => {
  const ctx = { client: {} as ToolContext["client"], cwd: "/", env: { CKANBAN_TICKET: "p/t_1" } } as ToolContext;
  const bad = await callTool("ask_questions", { questions: [q([opt("a", true), opt("b", true)])] }, ctx);
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("call ask_questions again");
  const ok = await callTool("ask_questions", { questions: [q()] }, ctx);
  expect(ok.isError).toBeUndefined();
  expect(ok.content[0].text).toBe("Shown to the user as a form. End your turn and wait for their reply.");
  expect((await callTool("propose_ticket", { title: "T", description: "D" }, ctx)).content[0].text).toContain("End your turn");
  expect((await callTool("propose_tickets", { tickets: [{ key: "a", title: "A", description: "D" }] }, ctx)).isError).toBeUndefined();
  expect((await callTool("propose_tickets", { tickets: [{ key: "a", title: "A", description: "D", dependsOn: ["b"] }] }, ctx)).isError).toBe(true);
  expect((await callTool("propose_branch", { reason: "try B" }, ctx)).content[0].text).toContain("End your turn");
  expect((await callTool("propose_branch", {}, ctx)).isError).toBeUndefined();
  expect((await callTool("propose_branch", { reason: 3 }, ctx)).isError).toBe(true);
});
