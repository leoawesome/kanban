# Claude Kanban

Local kanban web UI (Bun + TypeScript server in `src/`, React + Vite UI in `web/`) that runs tickets through headless `claude -p` sessions. Data lives in `~/.claude-kanban/`.

- **User asks to install / set it up:** follow `docs/install-ai.md` exactly (uses the release binary; no need to build from source).
- **Developing:** see README → Development. Tests: `bun test test`. Typecheck: `bunx tsc --noEmit`. UI build: `bun run build:web`.
- **After changing code while the daemon runs from source:** `bun run build:web && bun src/cli.ts restart`.
- **Releasing:** bump `package.json` version, `git tag vX.Y.Z && git push origin vX.Y.Z` (GitHub Actions builds and publishes).
- `src/server/web-assets.gen.ts` is a stub; `scripts/build-bin.ts` overwrites it during binary builds and restores it. Never commit a generated version.
