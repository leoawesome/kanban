import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFileName, artifactWaitMs, callTool, handleMessage, type ToolContext } from "../src/mcp-server";
import type { ArtifactJob } from "../src/server/artifact";
import { tempDir } from "./helpers";

const URL = "https://claude.ai/artifact/AbC-123";

function ctx(out: string, env: Record<string, string> = {}, outcome: any = null) {
  const jobs: { job: ArtifactJob; timeoutMs: number }[] = [];
  const c = {
    client: {} as ToolContext["client"], cwd: "/",
    // A planning chat: board run env, where board changes are refused.
    env: { CKANBAN_TICKET: "p/t_1", CKANBAN_OUTPUT_DIR: out, ...env },
    now: () => 42,
    async artifact(job: ArtifactJob, timeoutMs: number) {
      jobs.push({ job, timeoutMs });
      if (outcome) return outcome;
      return job.kind === "read"
        ? { ok: true, kind: "read", html: "<h1>Live</h1>" }
        : { ok: true, kind: "publish", url: job.url ?? URL, text: `Published ${job.file} at ${job.url ?? URL}` };
    },
  } as ToolContext;
  return { c, jobs };
}

test("artifact tools are read-only hinted, so plan-mode planning chats can call them", async () => {
  const r: any = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx("/o").c);
  for (const name of ["read_artifact", "publish_artifact"]) {
    expect(r.result.tools.find((t: any) => t.name === name)?.annotations).toEqual({ readOnlyHint: true });
  }
});

test("read_artifact returns the page source and writes nothing", async () => {
  const { c, jobs } = ctx("/nonexistent");
  const r = await callTool("read_artifact", { url: URL }, c);
  expect(r).toEqual({ content: [{ type: "text", text: "<h1>Live</h1>" }] });
  expect(jobs).toEqual([{ job: { kind: "read", url: URL }, timeoutMs: 180_000 }]);
});

test("publish_artifact saves the page in the outputs folder and updates the given link", async () => {
  const out = tempDir();
  const { c, jobs } = ctx(out);
  const r = await callTool("publish_artifact", { html: "<h1>New</h1>", url: URL, title: "Plan" }, c);
  const file = join(out, "artifacts", "abc-123.html");
  expect(r.content[0].text).toBe(`Published ${file} at ${URL}`);
  expect(readFileSync(file, "utf8")).toBe("<h1>New</h1>");
  expect(jobs[0].job).toEqual({ kind: "publish", file, url: URL, title: "Plan" });
});

test("publish_artifact without url publishes a new page named after its title", async () => {
  const out = tempDir();
  const { c, jobs } = ctx(out);
  await callTool("publish_artifact", { html: "<p>x</p>", title: "Q4 Roadmap!" }, c);
  expect(jobs[0].job).toEqual({ kind: "publish", file: join(out, "artifacts", "q4-roadmap.html"), url: undefined, title: "Q4 Roadmap!" });
});

test("artifact job failures come back as tool errors", async () => {
  const { c } = ctx(tempDir(), {}, { ok: false, error: "timed out after 180s waiting for the helper Claude session" });
  const r = await callTool("publish_artifact", { html: "<p>x</p>" }, c);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe("artifact publish failed: timed out after 180s waiting for the helper Claude session");
  expect((await callTool("read_artifact", { url: URL }, c)).content[0].text).toStartWith("artifact read failed:");
  expect((await callTool("publish_artifact", {}, c)).content[0].text).toBe("html is required");
});

test("artifact jobs stop before Claude Code's MCP tool timeout", () => {
  expect(artifactWaitMs({})).toBe(180_000);
  expect(artifactWaitMs({ MCP_TOOL_TIMEOUT: "60000" })).toBe(55_000);
  expect(artifactWaitMs({ MCP_TOOL_TIMEOUT: "600000" })).toBe(180_000);
  expect(artifactWaitMs({ MCP_TOOL_TIMEOUT: "junk" })).toBe(180_000);
});

test("artifactFileName: artifact id for updates, title slug for new pages, timestamp fallback", () => {
  expect(artifactFileName(URL, "x", 1)).toBe("abc-123.html");
  expect(artifactFileName("https://claude.ai/code/artifact/Zz9", undefined, 1)).toBe("zz9.html");
  expect(artifactFileName(undefined, "  ", 7)).toBe("artifact-7.html");
});
