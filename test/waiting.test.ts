import { expect, test } from "bun:test";
import { OLD_WAIT_MS, waitedFor } from "../web/src/time";

test("waitedFor: the Inbox's coarse waiting time", () => {
  const at = Date.parse("2026-10-10T12:00:00Z");
  const ago = (ms: number) => new Date(at - ms).toISOString();
  expect(waitedFor(ago(20_000), at)).toBe("just now");
  expect(waitedFor(ago(12 * 60_000), at)).toBe("12m");
  expect(waitedFor(ago(9 * 3600_000 + 59 * 60_000), at)).toBe("9h");
  expect(waitedFor(ago(28 * 3600_000), at)).toBe("1d 4h");
  expect(waitedFor(ago(48 * 3600_000), at)).toBe("2d");
  // A clock a little ahead never shows a negative wait.
  expect(waitedFor(ago(-5000), at)).toBe("just now");
  expect(OLD_WAIT_MS).toBe(8 * 3600_000);
});
