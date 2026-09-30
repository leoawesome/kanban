# Claude Kanban

Local kanban board for [Claude Code](https://claude.com/claude-code). Drop a ticket into **Ready** and a headless `claude -p` session picks it up, works it, and moves it to **Review** (opening a GitHub PR when it changed code). All data lives in plain files under `~/.claude-kanban/`.

## Features

- **Profiles**: one board per folder. *New profile* lists the folders you've recently run Claude Code in (from `~/.claude.json`), or *Browse…* opens the macOS folder picker. Base branch is auto-detected; model defaults to your Claude Code setting (`~/.claude/settings.json`); max parallel defaults to 5.
   Git repos get a worktree + branch per ticket (`ck/<id>-<title>`); plain folders are worked in place.
- **Auto pickup**: moving a card to Ready starts a run immediately, up to `maxParallel` per profile. Extra cards wait their turn.
- **Live activity**: the card shows Claude's latest action; the ticket drawer shows the full transcript (tool calls, results, cost).
- **One chat per ticket, like the terminal**: the ticket's Chat tab shows the whole Claude session (terminal messages and board runs) and has a message box. Send a message and Claude replies right away in the same session. Send one while Claude is working to steer it: like typing in interactive Claude Code, the current step finishes and Claude reads your message at its next step, without a restart.
  - **Backlog / Planning: refine.** Claude interviews you with a clickable question form, then proposes a clear title and description. Click *Apply to ticket*. Claude changes no files here.
  - **Ready: do the work** on its own (queued, up to max parallel).
  - **Review / Done: follow-up.** Your message is acted on straight away; the card shows In Progress, then returns to Review.
- **Terminal handoff**: *Copy resume command* (`cd <dir> && claude --resume <id>`) to continue any ticket's session yourself.
- **Live replies**: Claude's text appears in the chat while it is being written.
- **"Need you" inbox**: the top bar counts tickets on every board where Claude is waiting on you (questions, proposal, reply, blocked, failed); the browser tab shows the count too. Click to jump to one.
- **Links and shortcuts**: an open ticket is in the URL (`#/<board>/<ticket>`), so refresh keeps it and Back closes it. `N` new ticket, `/` search this board, `Esc` close.
- **Connections**: the top bar's *Connections* opens your Claude Code MCP servers, like `/mcp` (as `claude mcp list` sees them from your home folder, re-checked every 10 minutes). Log in again when an OAuth server expires (the browser opens; the status updates by itself), log out, add or remove user-scope servers. The badge counts servers that failed or used to work and now need you to log in.
- **PR tracking**: Review cards with a PR are checked every 5 minutes via `gh`; merged → Done (worktree removed).

Columns: Backlog → Planning → Ready → In Progress → Review → Done.

## Install (macOS)

You need [Claude Code](https://claude.com/claude-code) installed and logged in, plus `git`. For PRs, also install `gh` and run `gh auth login`.

```bash
curl -fsSL https://raw.githubusercontent.com/leoawesome/kanban/main/install.sh | bash
```

This downloads one self-contained binary to `~/.local/bin/ckanban` (no Bun/Node needed), starts it as a background service that launches at login, and opens http://localhost:7777.

Then click the profile menu → **New profile…**, pick a folder you've used Claude Code in, and create a ticket.

### Ask your AI to install it

Paste this into Claude Code (or any coding assistant with a terminal):

```text
Install Claude Kanban for me by following
https://raw.githubusercontent.com/leoawesome/kanban/main/docs/install-ai.md
```

The guide walks the assistant through prerequisites, install, PATH, verification and troubleshooting.

### Runs in the background, survives restarts

The installer registers a macOS launch agent, so the board:
- starts automatically when you log in (after a reboot too),
- restarts itself if it crashes,
- keeps running when you close the browser or terminal.

Tickets that were **In Progress** when the Mac shut down or the service restarted go back to Ready and resume the same Claude session automatically. Nothing needs to stay open except your Mac being on.

### Everyday commands

```bash
ckanban update      # get the latest release (the board also shows a banner when one is out)
ckanban restart     # restart the background service
ckanban open        # open the board
ckanban uninstall   # stop and remove the service (your boards in ~/.claude-kanban stay)
```

Logs: `~/.claude-kanban/daemon.log`. If `ckanban` isn't found, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`.

## Security

Runs use `--permission-mode bypassPermissions`: Claude can execute any command in the ticket's folder without asking. Only put tickets on boards whose folders you trust Claude to modify.

The server binds to `127.0.0.1` only and rejects requests with a non-localhost `Host` or cross-site `Origin`, so other websites cannot drive it.

## Data layout

```
~/.claude-kanban/
  config.json                    { "port": 7777, "prPollMinutes": 5 }
  mcp-seen.json                  MCP servers seen connected (so "needs auth" there counts as expired)
  profiles/<slug>/profile.json
  profiles/<slug>/tickets/<id>/ticket.md        YAML frontmatter + description
  profiles/<slug>/tickets/<id>/comments.jsonl
  profiles/<slug>/tickets/<id>/activity.jsonl   raw stream-json events
```

Env overrides: `CKANBAN_HOME`, `CKANBAN_PORT`, `CKANBAN_CLAUDE_BIN`.

## Development

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install && (cd web && bun install)
bun test test          # server tests (use a fake claude binary)
bun run build:web      # build the UI into web/dist
bun run dev            # API + UI on :7777 from source
cd web && bun run dev  # Vite dev server with /api proxy
bun run build:bin      # standalone binaries in dist/ (UI embedded)
```

Run from source as the daemon: `bun src/cli.ts install`.

### Releasing

Bump `version` in `package.json`, then:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions runs the tests, builds `ckanban-darwin-arm64` / `ckanban-darwin-x64` with the UI embedded, and publishes a GitHub Release. Users get it with `ckanban update`.

Design: `docs/superpowers/specs/2026-09-29-claude-kanban-design.md`.
