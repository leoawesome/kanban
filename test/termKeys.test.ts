import { expect, test } from "bun:test";
import { keyToInput, type KeyLike } from "../web/src/termKeys";

const ev = (over: Partial<KeyLike>): KeyLike => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...over,
});

test("Shift+Enter keydown sends ESC CR", () => {
  expect(keyToInput(ev({ shiftKey: true }))).toBe("\x1b\r");
});

test("Shift+Enter keypress/keyup are swallowed", () => {
  expect(keyToInput(ev({ shiftKey: true, type: "keypress" }))).toBeNull();
  expect(keyToInput(ev({ shiftKey: true, type: "keyup" }))).toBeNull();
});

test("plain Enter and other keys are left to xterm", () => {
  expect(keyToInput(ev({}))).toBeUndefined();
  expect(keyToInput(ev({ key: "a", shiftKey: true }))).toBeUndefined();
  for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
    expect(keyToInput(ev({ shiftKey: true, [mod]: true }))).toBeUndefined();
  }
  expect(keyToInput(ev({ shiftKey: true, isComposing: true }))).toBeUndefined();
});
