export const DEFAULT_UTF8_LOCALE = "en_US.UTF-8";

/**
 * `env` with a UTF-8 LANG. launchd starts the daemon without LANG/LC_*, and then `pbcopy` (Claude Code's
 * copy-on-select) reads text as Mac Roman, turning "↳" into "‚Ü≥". pbcopy looks at LANG before LC_ALL/LC_CTYPE
 * and only accepts a `<lang>.UTF-8` LANG, so LANG is what gets fixed. A UTF-8 LANG is kept; an explicit
 * non-UTF-8 LC_ALL is the user's override and is left alone. Programs following POSIX still see LC_ALL/LC_CTYPE first.
 */
export function withUtf8Locale(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (/\.utf-8$/i.test(env.LANG ?? "")) return env;
  if (env.LC_ALL && !/utf-?8/i.test(env.LC_ALL)) return env;
  return { ...env, LANG: DEFAULT_UTF8_LOCALE };
}
