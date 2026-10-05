import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude plan usage (what `/usage` shows in Claude Code), from Anthropic's undocumented OAuth endpoint.
// The OAuth token is read per request and never leaves this module: no logging, no caching, no response field.

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface UsageWindow {
  key: string;
  label: string;
  /** 0-100 */
  percent: number;
  resetsAt: string | null;
}

export type UsageResult = { windows: UsageWindow[]; fetchedAt: string } | { error: string; fetchedAt: string };

const LABELS: Record<string, string> = {
  five_hour: "Current session (5h)",
  seven_day: "Week · all models",
  seven_day_opus: "Week · Opus",
  seven_day_sonnet: "Week · Sonnet",
};

/** Turns the endpoint's JSON into windows; null when the shape is not what we expect. */
export function normalizeUsage(body: unknown): UsageWindow[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out: UsageWindow[] = [];
  let sawWindowKey = false;
  for (const [key, v] of Object.entries(body as Record<string, unknown>)) {
    // Other keys (extra usage, internal flags) are not plan windows.
    if (!/^(five_hour|seven_day)/.test(key)) continue;
    sawWindowKey = true;
    if (!v || typeof v !== "object") continue;
    const { utilization, resets_at } = v as Record<string, unknown>;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    const reset = typeof resets_at === "string" && !Number.isNaN(Date.parse(resets_at)) ? resets_at : null;
    out.push({
      key,
      label: LABELS[key] ?? `Week · ${key.replace(/^seven_day_?/, "").replace(/_/g, " ") || "other"}`,
      percent: Math.min(100, Math.max(0, utilization)),
      resetsAt: reset,
    });
  }
  if (!sawWindowKey) return null;
  const order = Object.keys(LABELS);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return out.sort((a, b) => rank(a.key) - rank(b.key));
}

export type Credentials = { token: string; expiresAt: number | null } | { error: string };

/** Parses Claude Code's stored credentials JSON (keychain secret or ~/.claude/.credentials.json). */
export function parseCredentials(raw: string): Credentials {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return { error: "Claude Code credentials are unreadable" };
  }
  const o = j?.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return { error: "Not logged in to Claude Code with a Claude plan" };
  return { token: o.accessToken, expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null };
}

async function readKeychain(): Promise<string | null> {
  try {
    const p = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

function readCredentialsFile(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    return readFileSync(join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
}

export async function readCredentials(): Promise<Credentials> {
  const raw = (process.platform === "darwin" ? await readKeychain() : null) ?? readCredentialsFile();
  if (!raw) return { error: "Not logged in to Claude Code" };
  return parseCredentials(raw);
}

export interface UsageDeps {
  credentials?: () => Promise<Credentials>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export async function fetchUsage(deps: UsageDeps = {}): Promise<UsageResult> {
  const now = deps.now ?? Date.now;
  const fetchedAt = () => new Date(now()).toISOString();
  const creds = await (deps.credentials ?? readCredentials)();
  if ("error" in creds) return { error: creds.error, fetchedAt: fetchedAt() };
  if (creds.expiresAt !== null && creds.expiresAt <= now()) {
    return { error: "Token expired: run any claude command to refresh it", fetchedAt: fetchedAt() };
  }
  let r: Response;
  try {
    r = await (deps.fetchFn ?? fetch)(USAGE_URL, {
      headers: {
        authorization: `Bearer ${creds.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
        "user-agent": "ckanban",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const timeout = (e as Error)?.name === "TimeoutError";
    return { error: timeout ? "Anthropic did not answer in time" : "Could not reach Anthropic (offline?)", fetchedAt: fetchedAt() };
  }
  if (r.status === 401 || r.status === 403) {
    return { error: "Token rejected: run any claude command to refresh it", fetchedAt: fetchedAt() };
  }
  if (r.status === 429) return { error: "Anthropic is rate limiting usage checks; try again in a minute", fetchedAt: fetchedAt() };
  if (!r.ok) return { error: `Anthropic answered HTTP ${r.status}`, fetchedAt: fetchedAt() };
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  const windows = normalizeUsage(body);
  if (!windows) return { error: "Unexpected answer from the usage endpoint", fetchedAt: fetchedAt() };
  return { windows, fetchedAt: fetchedAt() };
}
