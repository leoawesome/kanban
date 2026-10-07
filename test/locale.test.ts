import { expect, test } from "bun:test";
import { withUtf8Locale } from "../src/server/locale";

test("withUtf8Locale adds LANG when no locale is set", () => {
  expect(withUtf8Locale({ PATH: "/bin" })).toEqual({ PATH: "/bin", LANG: "en_US.UTF-8" });
  expect(withUtf8Locale({ LANG: "" })).toEqual({ LANG: "en_US.UTF-8" });
});

test("withUtf8Locale keeps a UTF-8 LANG", () => {
  for (const env of [{ LANG: "de_DE.UTF-8" }, { LANG: "en_GB.utf-8", LC_CTYPE: "C" }]) expect(withUtf8Locale(env)).toBe(env);
});

test("withUtf8Locale fixes a LANG pbcopy would read as Mac Roman", () => {
  // pbcopy checks LANG first and only accepts "<lang>.UTF-8", so LC_CTYPE alone doesn't help.
  expect(withUtf8Locale({ LANG: "C" })).toEqual({ LANG: "en_US.UTF-8" });
  expect(withUtf8Locale({ LANG: "en_US.utf8" })).toEqual({ LANG: "en_US.UTF-8" });
  expect(withUtf8Locale({ LANG: "C", LC_CTYPE: "en_US.UTF-8" })).toEqual({ LANG: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8" });
  expect(withUtf8Locale({ LC_CTYPE: "UTF-8" })).toEqual({ LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8" });
  expect(withUtf8Locale({ LC_ALL: "fr_FR.UTF-8" })).toEqual({ LANG: "en_US.UTF-8", LC_ALL: "fr_FR.UTF-8" });
});

test("withUtf8Locale leaves an explicit non-UTF-8 LC_ALL alone", () => {
  const env = { LC_ALL: "C" };
  expect(withUtf8Locale(env)).toBe(env);
});
