import { expect, test } from "bun:test";
import { newTicketId, shellQuote, slugify } from "../src/server/util";

test("slugify basic", () => {
  expect(slugify("Add Dark Mode!")).toBe("add-dark-mode");
});

test("slugify empty falls back to task", () => {
  expect(slugify("🚀🚀")).toBe("task");
});

test("slugify max length without trailing dash", () => {
  const s = slugify("word ".repeat(30));
  expect(s.length).toBeLessThanOrEqual(40);
  expect(s.endsWith("-")).toBe(false);
});

test("newTicketId format", () => {
  expect(newTicketId(new Date("2026-09-29T12:00:00Z"))).toMatch(/^t_20260929_[0-9a-z]{4}$/);
});

test("shellQuote", () => {
  expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
});
