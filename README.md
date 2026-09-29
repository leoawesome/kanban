# Claude Kanban

Local kanban board for [Claude Code](https://claude.com/claude-code). Drop a ticket into **Ready** and a headless `claude -p` session picks it up, works it, and moves it to **Review** (opening a GitHub PR when it changed code). All data lives in plain files under `~/.claude-kanban/`.

## Features

- **Profiles**: one board per folder. *New profile* lists the folders you've recently run Claude Code in (from `~/.claude.json`), or *Browse…* opens the macOS folder picker. Base branch is auto-detected; model defaults to your Claude Code setting (`~/.claude/settings.json`); max parallel defaults to 5.
   Git repos get a worktree + branch per ticket (`ck/<id>-<title>`); plain folders are worked in place.
- **Auto pickup**: moving a card to Ready starts a run immediately, up to `maxParallel` per profile. Extra cards wait their turn.
- **Live activity**: the card shows Claude's latest action; the ticket drawer shows the full transcript (tool calls, results, cost).
- **Review loop**: comment on a ticket, click *Comment & send to Claude*, and the same session resumes with your feedback.
- **Planning**: *Copy planning command* gives you a `claude` command for your terminal. Chat about the plan there; Claude rewrites the ticket description. Then move the card to Ready and the run continues the same session.
- **Terminal handoff**: *Copy resume command* (`cd <dir> && claude --resume <id>`) to continue any ticket's session yourself.
- **PR tracking**: Review cards with a PR are checked every 5 minutes via `gh`; merged → Done (worktree removed).

Columns: Backlog → Planning → Ready → In Progress → Review → Done.

## Requirements

- macOS (the daemon uses launchd; `ckanban dev` runs anywhere)
- [Bun](https://bun.sh) ≥ 1.1
- `claude` CLI, logged in
- `git`, and `gh` authenticated for PRs

## Install

```bash
bun install
bun run build:web
bun link            # optional: puts `ckanban` on your PATH

ckanban install     # launchd background daemon, starts at login
ckanban open        # http://localhost:7777
```

Or run in the foreground: `bun run dev`.

`ckanban restart` restarts it after pulling or building changes; `ckanban uninstall` removes it. Logs: `~/.claude-kanban/daemon.log`.

`ckanban install` records your current shell `PATH` in the launchd plist so the daemon can find `claude`, `git`, and `gh`. Re-run it if those move.

## Security

Runs use `--permission-mode bypassPermissions`: Claude can execute any command in the ticket's folder without asking. Only put tickets on boards whose folders you trust Claude to modify.

The server binds to `127.0.0.1` only and rejects requests with a non-localhost `Host` or cross-site `Origin`, so other websites cannot drive it.

## Data layout

```
~/.claude-kanban/
  config.json                    { "port": 7777, "prPollMinutes": 5 }
  profiles/<slug>/profile.json
  profiles/<slug>/tickets/<id>/ticket.md        YAML frontmatter + description
  profiles/<slug>/tickets/<id>/comments.jsonl
  profiles/<slug>/tickets/<id>/activity.jsonl   raw stream-json events
```

Env overrides: `CKANBAN_HOME`, `CKANBAN_PORT`, `CKANBAN_CLAUDE_BIN`.

## Development

```bash
bun test test        # server tests (uses a fake claude binary)
bun run dev          # API + built UI on :7777
cd web && bun run dev  # Vite dev server with /api proxy
```

Design: `docs/superpowers/specs/2026-09-29-claude-kanban-design.md`.
