import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvableMockup, approveMockup, extractMockups, mockupName, saveMockups, stripMockups } from "../src/server/mockups";
import { chatPrompt, firstRunPrompt, resumePrompt } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const reply = `Here are two layouts.
<ckanban-mockup name="a-compact.html">
\`\`\`html
<!doctype html><p>A</p>
\`\`\`
</ckanban-mockup>
<ckanban-mockup name="b-sidebar.html"><!doctype html><p>B</p></ckanban-mockup>
<ckanban-mockup name="../evil.html"><p>x</p></ckanban-mockup>
<ckanban-mockup name="approved.html"><p>x</p></ckanban-mockup>
Review them in the Outputs tab.`;

test("mockup names are plain html file names; approved.html is the board's", () => {
  expect(mockupName("a-compact.html")).toBe("a-compact.html");
  expect(mockupName("B_2.HTM")).toBe("B_2.HTM");
  for (const bad of ["../x.html", "a/b.html", "x.js", ".hidden.html", "a..b.html", "approved.html", ""]) expect(mockupName(bad)).toBeNull();
});

test("mockup blocks are extracted, fences dropped, bad names skipped", () => {
  expect(extractMockups(reply)).toEqual([
    { name: "a-compact.html", html: "<!doctype html><p>A</p>" },
    { name: "b-sidebar.html", html: "<!doctype html><p>B</p>" },
  ]);
});

test("the chat shows the reply without mockup blocks, even an unfinished one", () => {
  const s = stripMockups(reply);
  expect(s.names).toEqual(["a-compact.html", "b-sidebar.html"]);
  expect(s.text).not.toContain("<p>");
  expect(s.text).toContain("Here are two layouts.");
  expect(s.text).toContain("Review them in the Outputs tab.");
  expect(stripMockups('Drawing:\n<ckanban-mockup name="a.html"><html>').text.trim()).toBe("Drawing:");
});

test("mockups are saved to outputs/mockups and replaced by name", () => {
  const out = tempDir("ck-out-");
  expect(saveMockups(out, "no mockups")).toEqual([]);
  expect(existsSync(join(out, "mockups"))).toBe(false);
  expect(saveMockups(out, reply)).toEqual(["a-compact.html", "b-sidebar.html"]);
  expect(readFileSync(join(out, "mockups", "a-compact.html"), "utf8")).toBe("<!doctype html><p>A</p>\n");
  expect(existsSync(join(out, "evil.html"))).toBe(false);
  expect(existsSync(join(out, "mockups", "approved.html"))).toBe(false);
  saveMockups(out, '<ckanban-mockup name="a-compact.html"><p>A2</p></ckanban-mockup>');
  expect(readFileSync(join(out, "mockups", "a-compact.html"), "utf8")).toBe("<p>A2</p>\n");
});

test("only html files directly in mockups/ can be approved; approving copies to approved.html", () => {
  expect(approvableMockup("mockups/a.html")).toBe("mockups/a.html");
  expect(approvableMockup("mockups/approved.html")).toBe("mockups/approved.html");
  for (const bad of ["a.html", "mockups/x/a.html", "mockups/../ticket.md", "mockups/a.md", "other/a.html"]) expect(approvableMockup(bad)).toBeNull();
  const out = tempDir("ck-out-");
  mkdirSync(join(out, "mockups"));
  writeFileSync(join(out, "mockups", "a.html"), "A");
  writeFileSync(join(out, "mockups", "b.html"), "B");
  approveMockup(out, join(out, "mockups", "a.html"));
  expect(readFileSync(join(out, "mockups", "approved.html"), "utf8")).toBe("A");
  approveMockup(out, join(out, "mockups", "b.html"));
  expect(readFileSync(join(out, "mockups", "approved.html"), "utf8")).toBe("B");
  approveMockup(out, join(out, "mockups", "approved.html"));
  expect(readFileSync(join(out, "mockups", "approved.html"), "utf8")).toBe("B");
});

test("planning asks for mockup blocks; runs follow an approved mockup only when there is one", () => {
  const t = { id: "t_1", title: "New sidebar", body: "b", runCount: 1, mode: "auto" } as Ticket;
  const out = tempDir("ck-out-");
  const refine = chatPrompt(t, "", "refine", out);
  expect(refine).toContain('<ckanban-mockup name="a-compact.html">');
  expect(refine).toContain(join(out, "mockups"));
  expect(refine).toContain(join(out, "mockups", "approved.html"));
  expect(refine).toContain("Don't propose the final ticket for UI work until a mockup is approved");
  expect(chatPrompt(t, "hi", "act", out)).not.toContain("ckanban-mockup");
  const runs = () => [firstRunPrompt(t, { isGit: true, outputDir: out }), resumePrompt(t, [], out), chatPrompt(t, "hi", "act", out)];
  for (const p of runs()) expect(p).not.toContain("Approved design");
  mkdirSync(join(out, "mockups"));
  writeFileSync(join(out, "mockups", "approved.html"), "<p>ok</p>");
  for (const p of runs()) {
    expect(p).toContain("# Approved design");
    expect(p).toContain(join(out, "mockups", "approved.html"));
  }
  expect(chatPrompt(t, "", "refine", out)).not.toContain("# Approved design");
});
