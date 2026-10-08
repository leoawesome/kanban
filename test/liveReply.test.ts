import { expect, test } from "bun:test";
import { handoff, liveView, saved } from "../web/src/liveReply";

const reply = (text: string) => ({ role: "assistant" as const, kind: "text", text });
const RESULT = (summary: string) => `CKANBAN_RESULT: ${JSON.stringify({ status: "done", prUrl: null, summary })}`;

// The reply of ticket t_20261008_24aw's chat run 2 (shortened), as it streamed and as the session file saved it.
const final = `It works end to end, but I'd still improve eight things.

**Worth fixing (small):**
1. **Bundled skills often don't show in the picker.**
2. **Queued commands show the wrong hint.**

I'd do 1–2 as one small follow-up ticket.

<ckanban-move to="planning"/>

${RESULT("Slash commands work end to end, but a review found 8 things to improve.")}`;

test("a reply right after another reply's result line is found in the saved conversation", () => {
  // The previous run's reply ends with its result line; the moved reply is saved without the move tag.
  const entries = [
    reply(`Slash commands now run from every ticket chat.\n\n${RESULT("Pushed to main.")}`),
    reply(final.replace('<ckanban-move to="planning"/>', "").trim()),
  ];
  const h = handoff(final, 1);
  expect(h.flat.startsWith("It works end to end")).toBe(true);
  expect(saved(entries, h)).toBe(true);
});

test("the live copy stays while the saved reply isn't loaded yet", () => {
  const entries = [reply(`Earlier reply.\n\n${RESULT("Earlier.")}`)];
  expect(saved(entries, handoff(final, 1))).toBe(false);
});

test("stay tag and result line don't stop the match", () => {
  const text = `Proposed a follow-up.\n<ckanban-stay/>\n${RESULT("Proposed.")}`;
  const entries = [reply(`Before.\n${RESULT("x")}`), reply(`Proposed a follow-up.\n\n${RESULT("Proposed.")}`)];
  expect(saved(entries, handoff(text, 1))).toBe(true);
});

test("a reply split over several saved text blocks still matches", () => {
  const text = "First part.\n\nSecond part.";
  expect(saved([reply(`x\n${RESULT("x")}`), reply("First part."), reply("Second part.")], handoff(text, 1))).toBe(true);
});

test("only board blocks: waits for any new entry", () => {
  const h = handoff('<ckanban-questions>[{"question":"Q?"}]</ckanban-questions>', 1);
  expect(h.flat).toBe("");
  expect(saved([reply("a")], h)).toBe(false);
  expect(saved([reply("a"), reply("")], h)).toBe(true);
});

test("live view hides board blocks and the result line", () => {
  expect(liveView(final).text.endsWith("follow-up ticket.")).toBe(true);
  expect(liveView('Text\n<ckanban-questions>[').preparing).toBe("Preparing questions…");
});
