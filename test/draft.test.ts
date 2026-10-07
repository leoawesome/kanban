import { expect, test } from "bun:test";
import { DraftTracker } from "../src/server/draft";

const se = (event: any, extra: object = {}) => ({ type: "stream_event", event, ...extra });
const delta = (text: string) => se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });

test("accumulates text deltas and resets per message", () => {
  const d = new DraftTracker();
  expect(d.feed(se({ type: "message_start" }))).toBeNull();
  expect(d.feed(delta("Hel"))).toBe("Hel");
  expect(d.feed(delta("lo"))).toBe("Hello");
  expect(d.feed(se({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } }))).toBeNull();
  // the complete assistant message arrives: live text is no longer needed
  expect(d.feed({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })).toBe("");
  expect(d.feed(se({ type: "message_start" }))).toBeNull();
  expect(d.feed(delta("Next"))).toBe("Next");
});

test("separates text blocks within one message and ignores subagent streams", () => {
  const d = new DraftTracker();
  d.feed(delta("One"));
  d.feed(se({ type: "content_block_start", index: 1, content_block: { type: "text" } }));
  expect(d.feed(delta("Two"))).toBe("One\n\nTwo");
  expect(d.feed(se({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, { parent_tool_use_id: "toolu_1" }))).toBeNull();
});

test("non-stream events leave the draft alone", () => {
  const d = new DraftTracker();
  d.feed(delta("a"));
  expect(d.feed({ type: "system", subtype: "init" })).toBeNull();
  expect(d.feed({ type: "user", message: { content: [] } })).toBeNull();
  expect(d.text).toBe("a");
});

test("a clear keeps the finished text, so the chat can show its end", () => {
  const d = new DraftTracker();
  d.feed(delta("First half, "));
  d.feed(delta("second half."));
  expect(d.feed({ type: "assistant", message: { content: [{ type: "text", text: "First half, second half." }] } })).toBe("");
  expect(d.finished).toBe("First half, second half.");
  expect(d.text).toBe("");
  // a new message cutting in also hands over the old text
  d.feed(delta("Old"));
  expect(d.feed(se({ type: "message_start" }))).toBe("");
  expect(d.finished).toBe("Old");
  // nothing to hand over when no text was written
  expect(d.feed(se({ type: "message_start" }))).toBeNull();
  expect(d.finished).toBe("");
});
