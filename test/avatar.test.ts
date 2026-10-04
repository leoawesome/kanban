import { expect, test } from "bun:test";
import { AVATAR_COLORS, avatarColor, avatarLetter } from "../web/src/avatar";

test("avatarColor is stable and always from the palette", () => {
  for (const slug of ["kanban", "hyrox", "rocketbots", "berry-best", "", "a", "x".repeat(200)]) {
    expect(avatarColor(slug)).toBe(avatarColor(slug));
    expect(AVATAR_COLORS).toContain(avatarColor(slug) as (typeof AVATAR_COLORS)[number]);
  }
});

test("avatarColor spreads slugs over the palette", () => {
  const used = new Set(Array.from({ length: 50 }, (_, i) => avatarColor(`board-${i}`)));
  expect(used.size).toBeGreaterThan(3);
});

test("avatarLetter uppercases the first letter", () => {
  expect(avatarLetter("berry best")).toBe("B");
  expect(avatarLetter("  kanban")).toBe("K");
  expect(avatarLetter("")).toBe("?");
});
