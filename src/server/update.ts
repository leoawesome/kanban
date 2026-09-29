import { REPO, VERSION } from "./version";

export interface Release {
  version: string;
  url: string;
  assets: { name: string; url: string }[];
}

/** Latest GitHub release of this repo, or null when offline / rate-limited. */
export async function latestRelease(fetchFn: typeof fetch = fetch): Promise<Release | null> {
  try {
    const r = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ckanban" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return {
      version: String(j.tag_name ?? "").replace(/^v/, ""),
      url: String(j.html_url ?? ""),
      assets: (j.assets ?? []).map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url) })),
    };
  } catch {
    return null;
  }
}

/** Compares dotted versions; "dev" is never outdated. */
export function isNewer(latest: string, current: string): boolean {
  if (current === "dev" || !latest) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** Cached update check for the UI banner (GitHub is asked at most every 6 hours). */
export class UpdateChecker {
  private cached: { at: number; latest: Release | null } | null = null;

  constructor(private fetchFn: typeof fetch = fetch, private ttlMs = 6 * 3600_000) {}

  async status(): Promise<{ version: string; latest: string | null; updateAvailable: boolean; url: string | null }> {
    if (!this.cached || Date.now() - this.cached.at > this.ttlMs) {
      this.cached = { at: Date.now(), latest: await latestRelease(this.fetchFn) };
    }
    const latest = this.cached.latest;
    return {
      version: VERSION,
      latest: latest?.version ?? null,
      updateAvailable: !!latest && isNewer(latest.version, VERSION),
      url: latest?.url ?? null,
    };
  }
}
