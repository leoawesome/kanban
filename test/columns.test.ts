import { expect, test } from "bun:test";
import type { Status } from "../web/src/columns";
import { boardColumnOf, columnNeighbours, columnOrder } from "../web/src/columns";
import { opensNewTab } from "../web/src/links";

const tk = (id: string, status: Status, order: number, extra: { slotWait?: { at: string } } = {}) => ({ id, status, order, ...extra });

const board = [
  tk("b1", "backlog", 0), tk("p2", "planning", 1), tk("p1", "planning", 0), tk("p3", "planning", 2),
  tk("q1", "ready", 0), tk("r1", "in_progress", 0), tk("d1", "done", 0),
];

test("columnOrder lists one board column top to bottom; In Progress includes the queue", () => {
  expect(columnOrder(board, "planning")).toEqual(["p1", "p2", "p3"]);
  expect(columnOrder(board, "in_progress")).toEqual(["r1", "q1"]);
  expect(columnOrder(board, "review")).toEqual([]);
});

test("boardColumnOf puts queued tickets under In Progress", () => {
  expect(boardColumnOf(tk("q", "ready", 0))).toBe("in_progress");
  expect(boardColumnOf(tk("p", "planning", 0))).toBe("planning");
});

test("columnNeighbours stays in the column and stops at its ends", () => {
  const order = columnOrder(board, "planning");
  expect(columnNeighbours(order, "planning", "p1", board)).toEqual({ prev: null, next: "p2" });
  expect(columnNeighbours(order, "planning", "p3", board)).toEqual({ prev: "p2", next: null });
});

test("columnNeighbours keeps the open ticket's place after it moves, and skips others that left", () => {
  const order = columnOrder(board, "planning");
  const moved = board.map((t) => (t.id === "p2" ? { ...t, status: "done" as Status } : t));
  expect(columnNeighbours(order, "planning", "p2", moved)).toEqual({ prev: "p1", next: "p3" });
  // Stepped on to p3: p2 is now in Done, so Prev skips it.
  expect(columnNeighbours(order, "planning", "p3", moved)).toEqual({ prev: "p1", next: null });
  const deleted = board.filter((t) => t.id !== "p2");
  expect(columnNeighbours(order, "planning", "p1", deleted)).toEqual({ prev: null, next: "p3" });
});

test("opensNewTab: every link but same-page hash links", () => {
  expect(opensNewTab("https://example.com")).toBe(true);
  expect(opensNewTab("/api/attachments/x.png")).toBe(true);
  expect(opensNewTab("mailto:a@b.c")).toBe(true);
  expect(opensNewTab("#/kanban/t_1")).toBe(false);
  expect(opensNewTab(null)).toBe(false);
  expect(opensNewTab("")).toBe(false);
});
