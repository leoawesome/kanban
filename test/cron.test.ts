import { expect, test } from "bun:test";
import { cronError, describeCron, nextRun, nextRuns, parseCron } from "../src/server/cron";

// All dates local time, like the scheduler.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const next = (expr: string, from: Date) => nextRun(parseCron(expr), from);

test("every minute fires on the next whole minute", () => {
  expect(next("* * * * *", new Date(2026, 0, 1, 10, 0, 30))).toEqual(at(2026, 1, 1, 10, 1));
  expect(next("* * * * *", at(2026, 1, 1, 10, 0))).toEqual(at(2026, 1, 1, 10, 1));
});

test("steps, ranges and lists", () => {
  expect(nextRuns(parseCron("*/15 * * * *"), at(2026, 1, 1, 10, 1), 3)).toEqual([
    at(2026, 1, 1, 10, 15), at(2026, 1, 1, 10, 30), at(2026, 1, 1, 10, 45),
  ]);
  expect(nextRuns(parseCron("0 9-11 * * *"), at(2026, 1, 1, 9, 30), 3)).toEqual([
    at(2026, 1, 1, 10), at(2026, 1, 1, 11), at(2026, 1, 2, 9),
  ]);
  expect(nextRuns(parseCron("5,35 8 * * *"), at(2026, 1, 1, 8, 10), 2)).toEqual([at(2026, 1, 1, 8, 35), at(2026, 1, 2, 8, 5)]);
  expect(nextRuns(parseCron("10-30/10 * * * *"), at(2026, 1, 1, 8, 0), 4)).toEqual([
    at(2026, 1, 1, 8, 10), at(2026, 1, 1, 8, 20), at(2026, 1, 1, 8, 30), at(2026, 1, 1, 9, 10),
  ]);
  expect(next("5/20 * * * *", at(2026, 1, 1, 8, 30))).toEqual(at(2026, 1, 1, 8, 45));
});

test("weekdays skip the weekend", () => {
  // 2026-01-02 is a Friday.
  expect(next("0 9 * * 1-5", at(2026, 1, 2, 10))).toEqual(at(2026, 1, 5, 9));
  expect(next("0 9 * * mon-fri", at(2026, 1, 2, 8))).toEqual(at(2026, 1, 2, 9));
});

test("day of week 7 and names mean Sunday", () => {
  expect(next("0 0 * * 7", at(2026, 1, 1))).toEqual(at(2026, 1, 4));
  expect(next("0 0 * * SUN", at(2026, 1, 1))).toEqual(at(2026, 1, 4));
});

test("day of month and day of week: either matches when both are set", () => {
  // The 15th (Thu 2026-01-15) or any Monday (2026-01-05).
  expect(nextRuns(parseCron("0 0 15 * 1"), at(2026, 1, 1), 3)).toEqual([at(2026, 1, 5), at(2026, 1, 12), at(2026, 1, 15)]);
  // Only the day of month restricted: weekday does not matter.
  expect(next("0 0 15 * *", at(2026, 1, 1))).toEqual(at(2026, 1, 15));
});

test("month boundaries and short months", () => {
  expect(next("0 0 1 * *", at(2026, 1, 31, 12))).toEqual(at(2026, 2, 1));
  expect(next("0 0 31 * *", at(2026, 2, 1))).toEqual(at(2026, 3, 31));
  expect(next("59 23 31 12 *", at(2026, 12, 31, 23, 59))).toEqual(at(2027, 12, 31, 23, 59));
  expect(next("0 0 29 2 *", at(2026, 3, 1))).toEqual(at(2028, 2, 29));
  expect(next("0 12 * jun *", at(2026, 1, 1))).toEqual(at(2026, 6, 1, 12));
});

test("macros", () => {
  expect(next("@daily", at(2026, 1, 1, 5))).toEqual(at(2026, 1, 2));
  expect(next("@hourly", at(2026, 1, 1, 5, 1))).toEqual(at(2026, 1, 1, 6));
});

test("invalid expressions get a clear error", () => {
  expect(cronError("* * * *")).toContain("expected 5 fields");
  expect(cronError("60 * * * *")).toContain("minute 60 is out of range");
  expect(cronError("* 24 * * *")).toContain("hour 24");
  expect(cronError("*/0 * * * *")).toContain("step");
  expect(cronError("5-1 * * * *")).toContain("backwards");
  expect(cronError("x * * * *")).toContain('invalid minute value "x"');
  expect(cronError("0 0 30 2 *")).toBe("this schedule never fires");
  expect(cronError("0 9 * * 1-5")).toBeNull();
});

test("describeCron", () => {
  expect(describeCron("* * * * *")).toBe("Every minute");
  expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
  expect(describeCron("*/1 * * * *")).toBe("Every minute");
  expect(describeCron("0 * * * *")).toBe("Every hour");
  expect(describeCron("30 * * * *")).toBe("Every hour at :30");
  expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
  expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
  expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
  expect(describeCron("15 6 1 * *")).toBe("Monthly on day 1 at 06:15");
  expect(describeCron("0 9 1-7 * 1")).toBe("Cron: 0 9 1-7 * 1");
});
