# Changelog

What changed in each ckanban release. Get the latest with `ckanban update`.

## Unreleased

## [0.8.0] - 2026-10-08

### Added
- **Changes tab**: review a ticket's diff in the board (file tree or list, unified diff), comment on lines and send all comments to Claude as one message.
- **Worktree setup**: each new worktree gets your git-ignored `.env` files copied and dependencies installed before Claude starts. Both are auto-detected from your folder (*Board settings → Worktree setup*), with an optional cleanup command.
- **Prompt snippets**: save text you reuse under *⋯ → Snippets* and insert it with `@name` in the chat, new-ticket and description boxes.
- **⌘K command bar**: jump to any ticket on any board, any board, or run an action.
- **Subagents in the chat**: agents Claude launches show as rows with live status, their steps and result.
- **Slash commands in the ticket chat**: type `/` to pick a Claude Code command; only commands that can run headless are offered.
- Click a tool call in the ticket chat to see its full input and output.
- This changelog, also used as the release notes.
- `Shift+Enter` makes a new line when running `claude` in the embedded terminal.

### Fixed
- Switch boards with plain `1`–`9` instead of `Alt+1`–`9`.
- Copying non-ASCII text from the dock terminal pastes as UTF-8 instead of Mac Roman.
- A run whose Claude session was never saved starts a new session instead of failing every time.
- Reopened Done tickets get their worktree back; leftover worktrees are cleaned up on start.
- Finished chat replies no longer show twice under the *Moved to Planning* box.

## [0.7.0] - 2026-10-07

### Added
- Claude in Chrome in every board run and planning chat.
- Keyboard shortcuts to switch boards, select cards and mark tickets done (`?` lists them).
- Planner tickets control their children on request, adopt existing tickets, and respect exclusive resources (*Needs*, e.g. `emulator`).

### Fixed
- Chat replies that resume work respect the board's max parallel runs.
- A streamed chat reply no longer vanishes before its saved copy loads.

## [0.6.0] - 2026-10-06

### Added
- Branch a ticket into a new one with a copy of its conversation and code.
- Per-ticket Claude usage tab (≈% of the 5h window, cost, tokens).
- Share menu for output files, share links and file cards in the chat.
- Planning chats can read, update and publish claude.ai artifacts.
- New name and logo (ckanban), leaner header, image-first README.

### Fixed
- Runs stay alive while Claude waits on background tasks.

## [0.5.0] - 2026-10-05

### Added
- HTML mockups in planning, with feedback through the chat question form.
- Planning questions and ticket proposals via MCP tools; Review/Done chats can propose follow-up child tickets.
- Tickets can ask another ticket's Claude a question and get the reply.
- Outputs tab with folder sidebar, filter and image preview.
- New ticket dialog with *Start planning* / *Start now*; Ready merged into In Progress as a queue.
- Claude plan usage (5h / weekly %) as a header pill.
- Resizable ticket sidebar, session menu, wider profile switcher with letter avatars.
- Shows when a pending restart is holding runs.

### Fixed
- Chat replies cut off by a daemon restart resume; restart waits for active runs.
- Stale "Plan stuck" cleared; the plan has its own tab.
- Ticket drawer sizing (never wider than needed, can be dragged wider again).

## [0.4.2] - 2026-10-02

### Fixed
- Blank board on load when no ticket is open.

## [0.4.1] - 2026-10-02

### Fixed
- Drawer prev/next keeps the order from when it opened.

## [0.4.0] - 2026-10-02

### Added
- Plans: a planning chat proposes child tickets as cards, and the planner runs them unattended in dependency order.
- Drawer prev/next navigation, multi-line answers, full-height outputs.

### Fixed
- Planner wake-ups keep the planner's column and its own PR link.
- API connection retries show on the card instead of a frozen step.

## [0.3.0] - 2026-10-01

### Added
- Report ckanban bugs as GitHub issues from the board, ticket chat, MCP and CLI.
- MCP schedule tools so Claude can create and manage schedules.
- Calmer cards with one spinner, readable activity and live run time.

### Fixed
- Closing a ticket keeps its board; replies show as normal chat messages.
- Quick Claude chat is dark, fits the dock and knows the board.

## [0.2.0] - 2026-10-01

### Added
- Claude Code / Codex can manage the board via `ckanban mcp` and the `ckanban ticket` CLI.
- Quick Claude chat in the dock (no ticket needed), opened from the header's Claude button.

### Fixed
- Runs are never blocked by repo setup: base branch recovered, plain folders and empty repos work.

## [0.1.0] - 2026-10-01

First release.

- Kanban board per folder where a headless `claude -p` session works each ticket in its own git worktree and opens a PR; merged PRs move the card to Done.
- One terminal-like chat per ticket: refine in Planning with a question form, steer mid-run, follow up in Review.
- Link existing Claude Code sessions to tickets; live replies; "Need you" inbox across boards.
- Paste or drop images into descriptions and chat.
- Terminal & file explorer panel, Connections panel for MCP servers, scheduled tickets on a cron, claude.ai artifacts from runs.
- Standalone binary, installer, `ckanban update` and a background service that starts at login.

[0.8.0]: https://github.com/leoawesome/kanban/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/leoawesome/kanban/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/leoawesome/kanban/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/leoawesome/kanban/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/leoawesome/kanban/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/leoawesome/kanban/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/leoawesome/kanban/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/leoawesome/kanban/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/leoawesome/kanban/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/leoawesome/kanban/releases/tag/v0.1.0
