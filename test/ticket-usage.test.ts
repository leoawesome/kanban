import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import {
  ClaudeLogIndex, messageCost, priceFor, readWindows, recordWindow, ticketRuns, ticketUsage, UsageCache, type WindowSnapshot,
} from "../src/server/ticket-usage";
import type { ActivityEntry, Profile } from "../src/server/types";
import type { UsageResult } from "../src/server/usage";
import { approxPct, costText, modelName, tokenText } from "../web/src/usage";
import { tempDir } from "./helpers";

const H = 3600_000;
const T0 = Date.parse("2026-10-06T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A result event as Claude Code writes it: totals are running totals for the session. */
function result(session: string, total: number, models: Record<string, { tokens: number; cost: number }>) {
  return {
    type: "result", session_id: session, total_cost_usd: total,
    modelUsage: Object.fromEntries(Object.entries(models).map(([m, u]) => [m, { inputTokens: 0, outputTokens: u.tokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: u.cost }])),
  };
}
const entry = (run: number, at: number, event: unknown): ActivityEntry => ({ run, at: iso(at), event });

test("priceFor picks the model family; unknown models get the Opus price", () => {
  expect(priceFor("claude-opus-5-5[1m]")).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
  expect(priceFor("opus")).toEqual(priceFor("claude-opus-5-5"));
  expect(priceFor("claude-haiku-4-5-20251001").input).toBe(1);
  expect(priceFor("claude-sonnet-5-5").output).toBe(10);
  expect(priceFor("claude-fable-5-1").cacheRead).toBe(0.25);
  expect(priceFor("some-new-model")).toEqual(priceFor("claude-opus-5-5"));
});

test("messageCost prices input, output, cache reads and both cache write lengths", () => {
  const m = "claude-opus-5-5";
  expect(messageCost(m, { input_tokens: 1e6 })).toBeCloseTo(4);
  expect(messageCost(m, { output_tokens: 1e6 })).toBeCloseTo(20);
  expect(messageCost(m, { cache_read_input_tokens: 1e6 })).toBeCloseTo(0.2);
  expect(messageCost(m, { cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } })).toBeCloseTo(5 + 8);
  // No split: counted as 1 h writes (what Claude Code uses).
  expect(messageCost(m, { cache_creation_input_tokens: 1e6 })).toBeCloseTo(8);
  expect(messageCost(m, { output_tokens: 1e6, speed: "fast" })).toBeCloseTo(40);
  expect(messageCost(m, null)).toBe(0);
});

test("ticketRuns turns running session totals into per-run cost and tokens", () => {
  const runs = ticketRuns([
    entry(1, T0, { type: "ckanban_run", kind: "planning" }),
    entry(1, T0 + 1000, { type: "system", subtype: "init", permissionMode: "plan" }),
    entry(1, T0 + 2000, result("s1", 0.5, { "claude-opus-5-5[1m]": { tokens: 100, cost: 0.5 } })),
    entry(1, T0 + 3000, { type: "ckanban_run", kind: "work" }),
    entry(1, T0 + 4000, result("s1", 2, { "claude-opus-5-5[1m]": { tokens: 300, cost: 1.8 }, "claude-haiku-4-5": { tokens: 50, cost: 0.2 } })),
    // A steering turn inside the same run: same row.
    entry(1, T0 + 5000, { type: "system", subtype: "init" }),
    entry(1, T0 + 6000, result("s1", 2.5, { "claude-opus-5-5[1m]": { tokens: 400, cost: 2.3 }, "claude-haiku-4-5": { tokens: 50, cost: 0.2 } })),
    // A started run without a result yet is left out.
    entry(2, T0 + 7000, { type: "ckanban_run", kind: "chat" }),
  ]);
  expect(runs.map((r) => [r.kind, r.costUsd, r.tokens, r.model, r.parts.length])).toEqual([
    ["planning", 0.5, 100, "claude-opus-5-5[1m]", 1],
    ["work", 2, 350, "claude-opus-5-5[1m]", 2],
  ]);
  expect(runs[1].parts.map((p) => p.cost)).toEqual([1.5, 0.5]);
});

test("ticketRuns splits old logs (no markers) at each new turn and restarts totals for a new session", () => {
  const runs = ticketRuns([
    entry(1, T0, { type: "system", subtype: "init", permissionMode: "plan" }),
    entry(1, T0 + 1, result("a", 1, {})),
    entry(1, T0 + 2, { type: "system", subtype: "init", permissionMode: "bypassPermissions" }),
    entry(1, T0 + 3, result("a", 3, {})),
    entry(1, T0 + 3, result("a", 3, {})),
    entry(2, T0 + 4, { type: "system", subtype: "init" }),
    entry(2, T0 + 5, { ...result("b", 0.25, {}), usage: { input_tokens: 10, output_tokens: 5 } }),
  ]);
  expect(runs.map((r) => [r.run, r.kind, r.costUsd, r.tokens])).toEqual([[1, "planning", 1, 0], [1, "run", 2, 0], [2, "run", 0.25, 15]]);
});

test("ticketUsage splits a window between tickets by cost and scales by the window's %", () => {
  const w: WindowSnapshot = { start: iso(T0), end: iso(T0 + 5 * H), utilization: 40, seenAt: iso(T0 + H) };
  const old: WindowSnapshot = { start: iso(T0 - 6 * H), end: iso(T0 - H), utilization: 90, seenAt: iso(T0 - 2 * H) };
  const a = [
    entry(1, T0 - 3 * H, { type: "ckanban_run", kind: "work" }),
    entry(1, T0 - 3 * H, result("a", 3, {})),
    entry(2, T0 + H, { type: "ckanban_run", kind: "chat" }),
    entry(2, T0 + H, result("a", 5, {})),
  ];
  const b = [entry(1, T0 + 2 * H, { type: "ckanban_run", kind: "work" }), entry(1, T0 + 2 * H, result("b", 6, {}))];
  // Machine total: $10 in the current window ($2 + $6 from the tickets, $2 elsewhere), $6 in the old one.
  const machineCost = (s: number) => (s === T0 ? 10 : 6);
  const now = T0 + 3 * H;
  const ua = ticketUsage({ activity: a, windows: [old, w], machineCost, now });
  const ub = ticketUsage({ activity: b, windows: [old, w], machineCost, now });
  expect(ua.runs.map((r) => r.pct5h)).toEqual([45, 8]);
  expect(ua.totals).toEqual({ costUsd: 5, tokens: 0, pctCurrentWindow: 8, pctLifetime: 53 });
  expect(ub.totals.pctCurrentWindow).toBe(24);
  expect(ua.window).toEqual({ utilization: 40, resetsAt: w.end, seenAt: w.seenAt });
  // A machine total below the ticket's own cost (logs pruned): the ticket gets the whole window, never more.
  expect(ticketUsage({ activity: b, windows: [w], machineCost: () => 1, now }).totals.pctCurrentWindow).toBe(40);
});

test("ticketUsage without a known window keeps $ and tokens and says why % is missing", () => {
  const u = ticketUsage({
    activity: [entry(1, T0, result("a", 2, {}))], windows: [], machineCost: () => 0, now: T0, windowError: "Not logged in to Claude Code",
  });
  expect(u.totals).toEqual({ costUsd: 2, tokens: 0, pctCurrentWindow: null, pctLifetime: null });
  expect(u.runs[0].pct5h).toBeNull();
  expect(u.windowError).toBe("Not logged in to Claude Code");
});

function logLine(id: string, at: number, usage: object, model = "claude-opus-5-5", requestId = `req_${id}`) {
  return JSON.stringify({ type: "assistant", timestamp: iso(at), requestId, message: { id, model, usage, content: [] } }) + "\n";
}

test("ClaudeLogIndex sums logs incrementally, once per message, skipping files older than asked", async () => {
  const root = tempDir("ck-projects-");
  mkdirSync(join(root, "proj", "sess", "subagents"), { recursive: true });
  const main = join(root, "proj", "s1.jsonl");
  // Same message logged per content block; the last line has the final count.
  writeFileSync(main, logLine("m1", T0, { output_tokens: 10 }) + logLine("m1", T0, { output_tokens: 1e6 })
    + JSON.stringify({ type: "user", timestamp: iso(T0), message: { content: "hi" } }) + "\n"
    + logLine("m2", T0 + H, { input_tokens: 1e6 }, "<synthetic>"));
  writeFileSync(join(root, "proj", "sess", "subagents", "agent-1.jsonl"), logLine("m3", T0 + 2 * H, { output_tokens: 1e6 }, "claude-haiku-4-5"));
  const stale = join(root, "proj", "old.jsonl");
  writeFileSync(stale, logLine("m4", T0 - 48 * H, { output_tokens: 1e6 }));
  utimesSync(stale, new Date(T0 - 48 * H), new Date(T0 - 48 * H));

  const fresh = new Date(T0 + 3 * H);
  utimesSync(main, fresh, fresh);
  utimesSync(join(root, "proj", "sess", "subagents", "agent-1.jsonl"), fresh, fresh);
  let now = T0 + 3 * H;
  const idx = new ClaudeLogIndex(root, 10_000, () => now);
  await idx.refresh(T0 - H);
  expect(idx.costBetween(T0, T0 + 5 * H)).toBeCloseTo(20 + 5);
  expect(idx.costBetween(T0 - 72 * H, T0)).toBe(0);

  // Appended lines (and a half-written one) are picked up on the next refresh once the interval passed.
  appendFileSync(main, logLine("m5", T0 + 3 * H, { output_tokens: 1e6 }) + '{"type":"assistant"');
  await idx.refresh(T0 - H);
  expect(idx.costBetween(T0, T0 + 5 * H)).toBeCloseTo(25);
  now += 20_000;
  await idx.refresh(T0 - H);
  expect(idx.costBetween(T0, T0 + 5 * H)).toBeCloseTo(45);

  // Asking further back reads the older file too.
  await idx.refresh(T0 - 72 * H);
  expect(idx.costBetween(T0 - 72 * H, T0)).toBeCloseTo(20);
});

test("recordWindow keeps one snapshot per 5h window", () => {
  const file = join(tempDir("ck-win-"), "usage-windows.json");
  const answer = (pct: number, resetsAt: string, fetchedAt: string): UsageResult =>
    ({ windows: [{ key: "five_hour", label: "", percent: pct, resetsAt }], fetchedAt });
  recordWindow(file, answer(10, "2026-10-06T15:00:00Z", "2026-10-06T11:00:00Z"));
  recordWindow(file, answer(30, "2026-10-06T15:00:20Z", "2026-10-06T12:00:00Z"));
  recordWindow(file, { error: "nope", fetchedAt: "2026-10-06T12:30:00Z" });
  recordWindow(file, answer(5, "2026-10-06T21:00:00Z", "2026-10-06T17:00:00Z"));
  expect(readWindows(file).map((w) => [w.start, w.utilization])).toEqual([
    ["2026-10-06T10:00:20.000Z", 30],
    ["2026-10-06T16:00:00.000Z", 5],
  ]);
});

test("UsageCache reuses a recent answer and keeps errors only briefly", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const seen: UsageResult[] = [];
  const cache = new UsageCache(async () => {
    calls++;
    return fail ? { error: "x", fetchedAt: "" } : { windows: [], fetchedAt: "" };
  }, (r) => seen.push(r), () => now);
  await Promise.all([cache.get(60_000), cache.get(60_000)]);
  expect(calls).toBe(1);
  now = 30_000;
  await cache.get(60_000);
  expect(calls).toBe(1);
  await cache.get(0);
  expect(calls).toBe(2);
  fail = true;
  now = 400_000;
  await cache.get(300_000);
  expect(calls).toBe(3);
  now = 470_000;
  await cache.get(300_000);
  expect(calls).toBe(4);
  expect(seen.length).toBe(4);
});

test("web usage formatting", () => {
  expect(approxPct(null)).toBe("–");
  expect(approxPct(0)).toBe("≈ 0%");
  expect(approxPct(0.4)).toBe("≈ <1%");
  expect(approxPct(6.4)).toBe("≈ 6%");
  expect(costText(4.123)).toBe("$4.12");
  expect(costText(0.001)).toBe("<$0.01");
  expect(tokenText(2_134_000)).toBe("2.1M");
  expect(tokenText(34_000_000)).toBe("34M");
  expect(tokenText(340_400)).toBe("340k");
  expect(tokenText(820)).toBe("820");
  expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
  expect(modelName("claude-fable-5-1")).toBe("Fable 5.1");
  expect(modelName(null)).toBe("–");
});

describe_http();

function describe_http() {
  let server: ReturnType<typeof createServer>;
  let store: Store;
  let base: string;
  let usageCalls = 0;
  const now = Date.now();
  beforeAll(() => {
    store = new Store(tempDir("ck-home-"));
    store.saveProfile({ slug: "p", name: "P", path: tempDir("ck-proj-"), createdAt: iso(now) } as Profile);
    const root = tempDir("ck-projects-");
    mkdirSync(join(root, "proj"));
    writeFileSync(join(root, "proj", "s.jsonl"), logLine("x", now - H, { output_tokens: 1e6 }));
    const bus = new Bus();
    const board = new Board(store, bus, { claudeBin: "/bin/false" });
    server = createServer({
      store, bus, board, port: 0, webDir: tempDir("ck-web-"),
      claudeLogs: new ClaudeLogIndex(root),
      usage: async () => {
        usageCalls++;
        return { windows: [{ key: "five_hour", label: "", percent: 50, resetsAt: iso(now + 2 * H) }], fetchedAt: iso(now) };
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  test("GET ticket usage returns runs, totals and the current window", async () => {
    const slug = "p";
    const t = store.createTicket(slug, { title: "x", body: "", status: "backlog" });
    store.appendActivity(slug, t.id, 1, { type: "ckanban_run", kind: "work" });
    store.appendActivity(slug, t.id, 1, result("s", 5, { "claude-opus-5-5": { tokens: 1000, cost: 5 } }));
    const r = await fetch(`${base}/api/profiles/${slug}/tickets/${t.id}/usage`);
    expect(r.status).toBe(200);
    const u: any = await r.json();
    // Ticket $5 of a $20 machine window at 50%.
    expect(u.runs).toEqual([{ run: 1, kind: "work", startedAt: expect.any(String), model: "claude-opus-5-5", tokens: 1000, costUsd: 5, pct5h: 12.5 }]);
    expect(u.totals).toEqual({ costUsd: 5, tokens: 1000, pctCurrentWindow: 12.5, pctLifetime: 12.5 });
    expect(u.window.utilization).toBe(50);
    // The plan answer is reused, also by the header pill only when asked fresh.
    await fetch(`${base}/api/profiles/${slug}/tickets/${t.id}/usage`);
    expect(usageCalls).toBe(1);
    await fetch(`${base}/api/usage`);
    expect(usageCalls).toBe(2);
  });
}
