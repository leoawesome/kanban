import { expect, test } from "bun:test";
import { isNewer, latestRelease, UpdateChecker } from "../src/server/update";

test("isNewer", () => {
  expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  expect(isNewer("9.9.9", "dev")).toBe(false);
});

test("latestRelease parses GitHub response and survives errors", async () => {
  const ok = (async () => new Response(JSON.stringify({
    tag_name: "v0.3.1", html_url: "https://github.com/x/y/releases/v0.3.1",
    assets: [{ name: "ckanban-darwin-arm64", browser_download_url: "https://dl/arm" }],
  }))) as unknown as typeof fetch;
  expect(await latestRelease(ok)).toEqual({
    version: "0.3.1", url: "https://github.com/x/y/releases/v0.3.1",
    assets: [{ name: "ckanban-darwin-arm64", url: "https://dl/arm" }],
  });
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await latestRelease(boom)).toBeNull();
  const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  expect(await latestRelease(notFound)).toBeNull();
});

test("UpdateChecker caches GitHub calls", async () => {
  let calls = 0;
  const f = (async () => { calls++; return new Response(JSON.stringify({ tag_name: "v1.0.0", assets: [] })); }) as unknown as typeof fetch;
  const c = new UpdateChecker(f);
  const s = await c.status();
  await c.status();
  expect(calls).toBe(1);
  expect(s).toMatchObject({ version: "dev", latest: "1.0.0", updateAvailable: false });
});
