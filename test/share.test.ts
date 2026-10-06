import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactJob } from "../src/server/artifact";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { attachmentHeader, copyFileArgv, markdownPage, markdownTitle, revealArgv } from "../src/server/share";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;
const jobs: { job: ArtifactJob; html: string }[] = [];
let publishResult: { ok: true; kind: "publish"; url: string; text: string } | { ok: false; error: string } =
  { ok: true, kind: "publish", url: "https://claude.ai/artifact/abc-1", text: "" };
const bins = tempDir("ck-bins-");
const log = join(bins, "argv.log");
const env = { open: process.env.CKANBAN_OPEN_BIN, osa: process.env.CKANBAN_OSASCRIPT_BIN };

beforeAll(() => {
  // Fake open/osascript: record their argv, one call per line.
  const fake = join(bins, "fake");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s|' "$@" >> '${log}'\necho >> '${log}'\n`);
  chmodSync(fake, 0o755);
  process.env.CKANBAN_OPEN_BIN = fake;
  process.env.CKANBAN_OSASCRIPT_BIN = fake;
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({
    store, bus, board, port: 0, webDir: tempDir("ck-web-"),
    publishArtifact: async (job) => {
      if (job.kind === "publish") jobs.push({ job, html: readFileSync(job.file, "utf8") });
      return publishResult;
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  process.env.CKANBAN_OPEN_BIN = env.open;
  process.env.CKANBAN_OSASCRIPT_BIN = env.osa;
  if (env.open === undefined) delete process.env.CKANBAN_OPEN_BIN;
  if (env.osa === undefined) delete process.env.CKANBAN_OSASCRIPT_BIN;
});

const post = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers } });

async function ticketWithOutputs() {
  const path = tempDir("ck-plain-");
  const p = (await (await fetch(`${base}/api/profiles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Share ${Math.random()}`, path }) })).json()) as any;
  const t = (await (await fetch(`${base}/api/profiles/${p.slug}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", status: "backlog" }) })).json()) as any;
  const dir = store.outputsDir(p.slug, t.id);
  writeFileSync(join(dir, "Report ü.md"), "# Q3 report\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  writeFileSync(join(dir, "page.html"), "<!doctype html><title>x</title><p>hi</p>");
  writeFileSync(join(dir, "data.csv"), "a,b\n");
  return { slug: p.slug as string, id: t.id as string, dir, url: `/api/profiles/${p.slug}/tickets/${t.id}/outputs` };
}

const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
};

test("argv builders never put the path in a script or shell", () => {
  const argv = copyFileArgv("/x/a\"); $.system(\"rm.md");
  expect(argv.slice(0, 4)).toEqual(["osascript", "-l", "JavaScript", "-e"]);
  expect(argv[4]).toContain("fileURLWithPath(argv[0])");
  expect(argv[5]).toBe("/x/a\"); $.system(\"rm.md");
  expect(argv).toHaveLength(6);
  expect(revealArgv("/x/a.md", undefined, "darwin")).toEqual(["open", "-R", "/x/a.md"]);
  expect(revealArgv("/x/a.md", undefined, "linux")).toEqual(["xdg-open", "/x"]);
});

test("download header keeps the real name", () => {
  expect(attachmentHeader("Report ü.md")).toBe(`attachment; filename="Report _.md"; filename*=UTF-8''Report%20%C3%BC.md`);
});

test("markdown is published as a styled standalone page", () => {
  const html = markdownPage("# Runbook: *status*\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1 < 2\n```\n", "runbook.md");
  expect(html).toStartWith("<!doctype html>");
  expect(html).toContain("<title>Runbook: status</title>");
  expect(html).toContain("<table>");
  expect(html).toContain("let a = 1 &lt; 2");
  expect(html).toContain("prefers-color-scheme:dark");
  expect(html).not.toMatch(/<link|src="http|@import/);
  expect(markdownTitle("no heading", "dir/notes.md")).toBe("notes");
});

test("download, reveal and copy-file resolve inside the outputs folder only", async () => {
  const o = await ticketWithOutputs();
  let r = await fetch(`${base}${o.url}/${encodeURIComponent("Report ü.md")}?download=1`);
  expect(r.headers.get("content-disposition")).toBe(attachmentHeader("Report ü.md"));
  expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(r.headers.get("content-security-policy")).toBe("sandbox");
  r = await fetch(`${base}${o.url}/page.html`);
  expect(r.headers.get("content-disposition")).toBeNull();

  writeFileSync(log, "");
  r = await post(`${o.url}/page.html?action=reveal`);
  expect(r.status).toBe(200);
  r = await post(`${o.url}/${encodeURIComponent("Report ü.md")}?action=copy`);
  expect(r.status).toBe(200);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls[0]).toBe(`-R|${join(o.dir, "page.html")}|`);
  expect(calls[1]).toStartWith("-l|JavaScript|-e|function run(argv) {");
  expect(calls.join("\n")).toEndWith(`|${join(o.dir, "Report ü.md")}|`);

  for (const bad of ["..%2Fticket.md", "missing.md", "..%2F..%2F..%2Fconfig.json"]) {
    expect((await post(`${o.url}/${bad}?action=copy`)).status).toBe(404);
  }
  expect((await post(`${o.url}/page.html?action=nope`)).status).toBe(400);
  expect((await post(`${o.url}/page.html?action=copy`, { "x-ckanban-run": `${o.slug}/${o.id}` })).status).toBe(403);
  expect((await post(`${o.url}/page.html?action=copy`, { origin: "http://evil.com" })).status).toBe(403);
});

test("publish runs in the background, keeps one link per file and updates it", async () => {
  const o = await ticketWithOutputs();
  const ticket = async () => (await (await fetch(`${base}/api/profiles/${o.slug}/tickets/${o.id}`)).json()) as any;
  expect((await ticket()).outputDir).toBe(o.dir);

  let r = await post(`${o.url}/${encodeURIComponent("Report ü.md")}?action=publish`);
  expect(r.status).toBe(202);
  await waitFor(async () => (await ticket()).shareLinks?.length === 1);
  let t = await ticket();
  expect(t.shareLinks).toEqual([{ file: "Report ü.md", url: "https://claude.ai/artifact/abc-1", at: expect.any(String) }]);
  expect(t.shareJobs).toEqual([]);
  expect(jobs.at(-1)!.job).toEqual({ kind: "publish", file: expect.stringMatching(/share-tmp\/.+\.html$/), title: "Q3 report" });
  expect(jobs.at(-1)!.html).toContain("<table>");

  // Again: passes the stored link so it stays the same.
  r = await post(`${o.url}/${encodeURIComponent("Report ü.md")}?action=publish`);
  expect(r.status).toBe(202);
  await waitFor(async () => jobs.length === 2 && (await ticket()).shareJobs.length === 0);
  expect((jobs.at(-1)!.job as any).url).toBe("https://claude.ai/artifact/abc-1");
  expect((await ticket()).shareLinks).toHaveLength(1);

  // HTML goes as is; failures are reported on the ticket view.
  publishResult = { ok: false, error: "tmux is required" };
  r = await post(`${o.url}/page.html?action=publish`);
  expect(r.status).toBe(202);
  await waitFor(async () => (await ticket()).shareJobs[0]?.state === "failed");
  t = await ticket();
  expect(jobs.at(-1)!.job).toEqual({ kind: "publish", file: join(o.dir, "page.html") });
  expect(t.shareJobs[0]).toMatchObject({ file: "page.html", state: "failed", error: "tmux is required" });

  r = await post(`${o.url}/data.csv?action=publish`);
  await waitFor(async () => (await ticket()).shareJobs.some((j: any) => j.file === "data.csv" && j.state === "failed"));
});
