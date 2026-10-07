import { expect, test } from "bun:test";
import { boardDigit, cardDir, stepBoard, stepCard } from "../web/src/keynav";

test("cardDir maps J/K/H/L and arrows, ignores other keys", () => {
  expect(cardDir("j")).toBe("down");
  expect(cardDir("ArrowDown")).toBe("down");
  expect(cardDir("K")).toBe("up");
  expect(cardDir("ArrowUp")).toBe("up");
  expect(cardDir("h")).toBe("left");
  expect(cardDir("ArrowRight")).toBe("right");
  expect(cardDir("l")).toBe("right");
  expect(cardDir("n")).toBeNull();
  expect(cardDir("Enter")).toBeNull();
});

test("stepCard with nothing selected picks the first card of the first non-empty column", () => {
  expect(stepCard([0, 0, 3, 1], null, "down")).toEqual({ col: 2, row: 0 });
  expect(stepCard([0, 0, 3, 1], null, "left")).toEqual({ col: 2, row: 0 });
  expect(stepCard([0, 0], null, "down")).toBeNull();
});

test("stepCard moves up and down within a column, clamped", () => {
  expect(stepCard([3], { col: 0, row: 0 }, "down")).toEqual({ col: 0, row: 1 });
  expect(stepCard([3], { col: 0, row: 2 }, "down")).toEqual({ col: 0, row: 2 });
  expect(stepCard([3], { col: 0, row: 0 }, "up")).toEqual({ col: 0, row: 0 });
});

test("stepCard sideways skips empty columns, keeps the row and clamps to shorter columns", () => {
  expect(stepCard([4, 0, 2], { col: 0, row: 1 }, "right")).toEqual({ col: 2, row: 1 });
  expect(stepCard([4, 0, 2], { col: 0, row: 3 }, "right")).toEqual({ col: 2, row: 1 });
  expect(stepCard([4, 0, 2], { col: 2, row: 1 }, "left")).toEqual({ col: 0, row: 1 });
  // At the edge: stay put.
  expect(stepCard([4, 0, 2], { col: 2, row: 0 }, "right")).toEqual({ col: 2, row: 0 });
  expect(stepCard([4, 0, 0], { col: 0, row: 2 }, "right")).toEqual({ col: 0, row: 2 });
});

test("stepCard recovers when the selected column emptied", () => {
  expect(stepCard([0, 2], { col: 0, row: 0 }, "down")).toEqual({ col: 1, row: 0 });
});

test("stepBoard wraps around both ways", () => {
  expect(stepBoard(3, 0, 1)).toBe(1);
  expect(stepBoard(3, 2, 1)).toBe(0);
  expect(stepBoard(3, 0, -1)).toBe(2);
  expect(stepBoard(1, 0, 1)).toBe(0);
  expect(stepBoard(3, -1, 1)).toBe(0);
  expect(stepBoard(0, 0, 1)).toBe(-1);
});

test("boardDigit reads the physical key, 1-9 only", () => {
  expect(boardDigit("Digit1")).toBe(0);
  expect(boardDigit("Digit9")).toBe(8);
  expect(boardDigit("Numpad2")).toBe(1);
  expect(boardDigit("Digit0")).toBeNull();
  expect(boardDigit("KeyA")).toBeNull();
});
