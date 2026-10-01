# Claude Kanban

Local kanban web UI (Bun + TypeScript server in `src/`, React + Vite UI in `web/`) that runs tickets through headless `claude -p` sessions. Data lives in `~/.claude-kanban/`.

<!-- TEMPORARY: direct-to-main workflow. Remove this whole section when Leo says so. -->
## Temporary workflow: push straight to main (no PR)

Only Leo uses this repo, so no review step for now. **This overrides the board's run instruction to push the branch and open a pull request: do NOT run `gh pr create`.** Land every ticket that changes files directly on `main`:

1. **Check:** run `bun test test` and `bunx tsc --noEmit` (plus `bun run build:web` if `web/` changed). If anything fails, fix it and re-run until green.
2. **Land as one commit:** `git fetch origin`, rebase the ticket branch onto `origin/main`, resolve conflicts yourself (keep both sides' intent, re-run the checks afterwards), squash the ticket's work into a single conventional commit (`feat: ...` / `fix: ...`), then `git push origin HEAD:main`. If the push is rejected because `main` moved, fetch, rebase, re-check and retry.
3. **Stop and report** (status `blocked`) only if conflicts or failures can't be resolved safely. Never force-push `main`.
4. **Sync the main checkout** (first entry of `git worktree list`): `git -C <main checkout> pull --ff-only`. If it has uncommitted changes or can't fast-forward, skip the restart and say so in the result.
5. **Restart:** sum `running` from `curl -s http://localhost:7777/api/profiles` (this ticket counts itself). If the total is `1`, schedule a detached, delayed rebuild + restart so this run finishes first: `nohup sh -c 'sleep 20; cd <main checkout> && bun run build:web && bun src/cli.ts restart' >/dev/null 2>&1 &`. Never run `restart` directly; it kills the current run. If other tickets are running, do NOT restart; say a restart is pending and wait for Leo to ask.
6. **Result line:** `prUrl` is `null`; the summary includes the pushed commit SHA on `main` and whether the restart was scheduled or skipped (and why).
<!-- END TEMPORARY -->

- **User asks to install / set it up:** follow `docs/install-ai.md` exactly (uses the release binary; no need to build from source).
- **Developing:** see README → Development. Tests: `bun test test`. Typecheck: `bunx tsc --noEmit`. UI build: `bun run build:web`.
- **After changing code while the daemon runs from source:** `bun run build:web && bun src/cli.ts restart`.
- **Releasing:** bump `package.json` version, `git tag vX.Y.Z && git push origin vX.Y.Z` (GitHub Actions builds and publishes).
- `src/server/web-assets.gen.ts` is a stub; `scripts/build-bin.ts` overwrites it during binary builds and restores it. Never commit a generated version.
