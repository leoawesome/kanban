# ckanban: features in detail

Everything the board does, in depth. Back to the [README](../README.md).

## All features

- **Profiles**: one board per folder. *New profile* lists the folders you've recently run Claude Code in (from `~/.claude.json`), or *Browse…* opens the macOS folder picker. Base branch is auto-detected; model defaults to your Claude Code setting (`~/.claude/settings.json`); max parallel defaults to 5.
   Git repos get a worktree + branch per ticket (`ck/<id>-<title>`); plain folders are worked in place.
- **Worktree setup**: a fresh worktree lacks git-ignored files (`.env`, `node_modules`), so the board prepares it before Claude's first step. *Board settings → Worktree setup* holds three things, filled in automatically when a board is created (once for older boards, on the first start after upgrading; *↺ Detect again* re-runs it), with an *Auto-detected* badge while untouched:
  - **Files to copy**: paths or globs relative to the folder. Detected: git-ignored `.env*` files in the folder and its first-level subfolders (never `node_modules` or build output). Missing files are skipped; files already in the worktree are left alone.
  - **Setup command**: runs in the new worktree through your login shell (10 minute limit). Detected from lockfiles in the folder and its first-level subfolders, joined with `&&`: `bun.lock`/`bun.lockb` → `bun install`, `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json` → `npm ci`, `uv.lock` → `uv sync`, `poetry.lock` → `poetry install`, `Gemfile.lock` → `bundle install` (subfolders as `(cd web && …)`; nothing for Go or Cargo, which fetch on build). If it fails, Claude starts anyway and is shown the last 40 lines of output.
  - **Cleanup command** (optional): runs in a worktree before the board removes it; its errors are logged and never block removal.
  The ticket chat shows one *Worktree setup · Ns* row (copied files, the command with ✓/✗, click for output). Setup only runs when the board creates a worktree, on git boards.
- **Auto pickup**: moving a card to Ready starts a run immediately, up to `maxParallel` per profile. Extra cards wait their turn.
- **Live activity**: the card shows Claude's latest action; the ticket drawer shows the full transcript (tool calls, results, cost).
- **One chat per ticket, like the terminal**: the ticket's Chat tab shows the whole Claude session (terminal messages and board runs) and has a message box. Send a message and Claude replies right away in the same session. Send one while Claude is working to steer it: like typing in interactive Claude Code, the current step finishes and Claude reads your message at its next step, without a restart.
  - **Backlog / Planning: refine.** Claude interviews you with a clickable question form, then proposes a clear title and description. Click *Apply to ticket*. Claude changes no files here. For UI work it also draws HTML mockups, which the board saves to the ticket's `outputs/mockups/` and previews (sandboxed) in the Outputs tab. Claude then asks one question per design decision in the chat's question form, with a *Preview* link per option: pick and comment on everything, then send once. The final ticket names the chosen mockups as its *Target design*, and the dev run builds against them.
  - **Ready: do the work** on its own (queued, up to max parallel).
  - **Review / Done: follow-up.** Your message is acted on straight away; the card shows In Progress, then returns to Review.
- **Terminal handoff**: *Copy resume command* (`cd <dir> && claude --resume <id>`) to continue any ticket's session yourself.
- **Terminal & files**: *Terminal & files* in the top bar (or ``Ctrl+` ``) opens a bottom panel for the board's folder: a real interactive shell (vim, `claude`, colours all work) and a read-only file tree with syntax highlighting (gitignored files hidden). The shell keeps running when you close the panel or reload, and picks up where you left off.
- **Live replies**: Claude's text appears in the chat while it is being written.
- **"Need you" inbox**: the top bar counts tickets on every board where Claude is waiting on you (questions, proposal, reply, blocked, failed); the browser tab shows the count too. Click to jump to one.
- **Links and shortcuts**: an open ticket is in the URL (`#/<board>/<ticket>`), so refresh keeps it and Back closes it. `N` new ticket, `/` search this board, ``Ctrl+` `` terminal & files, `Esc` close.
- **Command bar (`⌘K` / `Ctrl+K`)**: one box to jump anywhere without the mouse. Type part of a ticket title from any board (letters in order are enough; matches are highlighted; the current board's tickets come first), an action (New ticket, Terminal & files, Quick Claude chat, Inbox, Schedules, Connections, Snippets, Usage, Board settings, Keyboard shortcuts, …) or a board name (*Switch to …*, with its `1`…`9` key). With nothing typed it lists the active tickets touched most recently. `↑`/`↓` move, `Enter` opens (switching board if needed), `Esc` closes. Works with no board selected; not inside the terminal, where `⌘K`/`Ctrl+K` belongs to the shell.
- **Connections**: *⋯ → Connections* in the top bar opens your Claude Code MCP servers, like `/mcp` (as `claude mcp list` sees them from your home folder, re-checked every 10 minutes). Log in again when an OAuth server expires (the browser opens; the status updates by itself), log out, add or remove user-scope servers. The chip next to it (and a dot on ⋯) counts servers that failed or used to work and now need you to log in.
- **Schedules**: *⋯ → Schedules* in the top bar holds recurring tickets for the board: a name, ticket title (`{date}` / `{time}` filled in), prompt and cron expression (presets, or any 5-field cron in local time). Each time one fires, a new ticket is created and starts right away; cards from schedules carry a clock badge, failed runs land in the inbox. Pause/resume, *Run now*, and a history of every fire (ticket + status, or "skipped" while the previous run is still going) and every edit (who, what, previous prompt). Claude can manage schedules too (see the MCP tools below). The daemon itself keeps time (no system crontab, no Claude Code `/loop`), so schedules only fire while it runs; a run missed while it was off fires once on start.
- **Plans**: in a ticket's Planning chat, ask Claude to split the work into tickets. It proposes them as cards (with dependencies between them); *Create all* adds them to Backlog, linked to the planner ticket. *Start plan* in the planner's details then runs them unattended: the board starts children in dependency order, a few at a time (*At once*, default 2), in auto mode. The planner's Claude session is only woken when a child fails, is blocked, asks questions or finishes with an open PR (it can retry, rewrite, split, skip, answer or merge, but only its own children), and once at the end to run the full checks and write `plan-summary.md`. If it can't continue, the plan pauses as *Stuck* and you get a notification; *Resume plan* continues.
- **Shared resources**: give tickets that use something only one may use at a time a *Needs* entry (e.g. `emulator`, in the ticket's details, `propose_tickets`, `create_ticket`/`update_ticket` or `ckanban ticket update <id> --needs emulator`). Tickets that need the same thing never run at the same time, on any board of this machine, in any order; the others keep running. A ticket waiting for one shows *waiting* and keeps its place without taking a run slot.
- **Manager mode**: ask any ticket's chat (outside Backlog/Planning) to manage tickets, e.g. "run all Backlog tickets, the emulator ones one at a time". Its Claude adopts them (`adopt_tickets`; tickets in another plan or done are skipped), sets their order and needs, and starts the plan (`plan_control`). A plan never starts a child that waits on you (open questions, a proposal to apply, in Planning); it shows *Needs you* in the Plan tab.
- **Use the board from other agents**: Claude Code, Codex (or any MCP client) can create, list, update, move, start, steer and stop tickets through `ckanban mcp`, so you can say "find what's left to do in this repo and put it on my board". See [Use the board from Claude Code / Codex](#use-the-board-from-claude-code--codex).
- **PR tracking**: Review cards with a PR are checked every 5 minutes via `gh`; merged → Done (worktree removed).

Columns: Backlog → Planning → Ready → In Progress → Review → Done.

## Runs in the background, survives restarts

The installer registers a macOS launch agent, so the board:
- starts automatically when you log in (after a reboot too),
- restarts itself if it crashes,
- keeps running when you close the browser or terminal.

Tickets that were **In Progress** when the Mac shut down or the service restarted go back to Ready and resume the same Claude session automatically. A chat or Planning reply that a restart cut off keeps what Claude had written so far (greyed out) and continues on its own after the restart. Nothing needs to stay open except your Mac being on.

## Use the board from Claude Code / Codex

`ckanban mcp` is an MCP server (stdio) that gives other agents tools for your board, so you can manage it from any Claude Code or Codex session:

```bash
ckanban mcp install            # register it with Claude Code (user scope) and Codex (~/.codex/config.toml)
ckanban mcp install --codex    # just one of them (--claude / --codex)
ckanban mcp status             # where it's registered
ckanban mcp uninstall
```

Or open *⋯ → Connections* on the board and click **Add** next to Claude Code / Codex. Other MCP clients can run `ckanban mcp` themselves.

Then ask, for example:

- "Scan this repo for TODOs and unfinished work and create a ticket on my board for each."
- "What's on my board? Start the dark-mode ticket."
- "Tell the ticket about the login bug to also cover password reset."
- "Every weekday at 9, check CI on main and fix what's failing." (creates a schedule)

Tools: `list_profiles`, `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `move_ticket`, `chat_ticket`, `stop_ticket`, `comment_ticket`, `delete_ticket`, `adopt_tickets`, `plan_control`, `report_bug`, `ask_ticket`, `reply_ticket`, and for schedules `list_schedules`, `create_schedule`, `update_schedule` (also pause/resume), `delete_schedule`, `run_schedule`, `schedule_history`. New tickets land in **Backlog** in interview mode unless you ask otherwise. Every tool acts on the board whose folder contains the agent's working directory (a git worktree counts as its main checkout); pass `profile` to pick another. Answering a question form and applying a proposed ticket still happen on the board.

Board runs see the same server but can only read: inside a run (`CKANBAN_TICKET` is set) every tool that changes the board refuses, so a run can't create or start other runs. `report_bug` doesn't touch the board, so it works from a ticket chat too. Schedule edits are the exception: `create_schedule`, `update_schedule` and `delete_schedule` work inside runs (ask for a schedule from any ticket chat; a scheduled run is told its schedule id and may refine its own prompt), because they only change future runs, which you can pause. Each edit is recorded in the schedule's history with who made it (you, or Claude in which ticket) and the previous title/prompt/timing. `run_schedule` starts a run immediately, so it stays refused inside runs. The other exception is a planner, on its own child tickets only: its wake-up runs while the plan runs, and its replies to your own messages in its chat (any plan state except done; that is also when `adopt_tickets` and `plan_control` start/resume work). They may use `create_ticket`, `update_ticket`, `move_ticket`, `chat_ticket`, `stop_ticket` and `comment_ticket` on that plan's child tickets only (the daemon checks this; every change is logged on the child, and retries and new children are capped).

Tickets can also talk to each other: a run's Claude can ask the Claude of another ticket on the same board a question with `ask_ticket`. The question goes into that ticket's real session (it steers the run if Claude is working there, or starts a short reply that leaves the card, outcome and run count alone), and the asker's call waits up to 10 minutes for the answer, which the other Claude sends with `reply_ticket` (an answer, or a clarifying question back). Both tickets' chats show the exchange. A reply that comes after the wait ends goes into the asker's run as a message, or becomes a comment for its next run. Only tickets that Claude has already worked on can be asked. If you set `MCP_TOOL_TIMEOUT` below 10 minutes, the wait is shortened to fit.

The same operations work from a terminal:

```bash
ckanban profiles
ckanban ticket list [--status ready]
ckanban ticket show <id>
ckanban ticket create --title "Add dark mode" --body-file notes.md   # or --body "...", or --body - (stdin)
ckanban ticket update <id> [--title ...] [--body ...] [--status ...] [--mode interview|auto]
ckanban ticket move <id> ready     # starts a run, like dragging the card
ckanban ticket chat <id> "also handle the empty state"
ckanban ticket comment <id> "note for the next run"
ckanban ticket stop <id>
ckanban ticket delete <id>
ckanban ticket report-bug [<id>] --title "Chat froze" --body "1. ..."   # files a ckanban bug on GitHub
```

Add `--profile <slug>` to pick a board explicitly and `--json` for machine-readable output. The daemon must be running.

## Reporting bugs

Found a bug in ckanban? Use **⋯ → Report a bug** in the header, or **Report a bug in ckanban** in a ticket's details to attach that ticket. You see everything that will be sent (version and OS, ticket details, last run result and log tail) and can untick any of it; home and data paths and secret-looking values are hidden. It's filed as an issue on `leoawesome/kanban` with `gh`. Without `gh` (or logged out) you get a prefilled GitHub link instead. `gh` can't upload images, so screenshots are listed for you to drag into the issue. In a ticket chat you can also ask Claude to "report this as a ckanban bug": it drafts the issue, asks you to confirm, then files it.

## claude.ai artifacts from board runs

Board runs are headless (`claude -p`), where Claude Code turns the built-in Artifact tool off. Runs are told to use `ckanban artifact publish <file> [--url <artifact url>]` and `ckanban artifact read <url> --out <file>` instead. These start a short interactive `claude` in a hidden tmux session (in `~/.claude-kanban/artifact-helper`), which has the tool, and read the result from its transcript. Needs `tmux` (`brew install tmux`) and Claude Code signed in with `/login`. Published pages show on the ticket.

## Data layout

```
~/.claude-kanban/
  config.json                    { "port": 7777, "prPollMinutes": 5 }
  mcp-seen.json                  MCP servers seen connected (so "needs auth" there counts as expired)
  snippets.json                  prompt snippets (⋯ → Snippets; scope "global" or a board slug), inserted with @name
  profiles/<slug>/profile.json
  profiles/<slug>/tickets/<id>/ticket.md        YAML frontmatter + description
  profiles/<slug>/tickets/<id>/comments.jsonl
  profiles/<slug>/tickets/<id>/activity.jsonl   raw stream-json events
  profiles/<slug>/schedules/<id>.json           recurring ticket template
  profiles/<slug>/schedules/<id>.history.jsonl  fires, skips and errors
```

Env overrides: `CKANBAN_HOME`, `CKANBAN_PORT`, `CKANBAN_CLAUDE_BIN`.
