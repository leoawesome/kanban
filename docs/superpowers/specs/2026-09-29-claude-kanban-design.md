# Claude Kanban — Design

Date: 2026-09-29
Status: Approved (brainstorming), pending spec review

## Goal

Local web kanban board for Claude Code. User creates tickets; Claude Code picks them up automatically and works them headlessly. One board per profile (profile = a folder, usually a git repo). Planning tickets can be refined interactively with Claude in the terminal before being queued. All data stored as local files — no third-party services beyond `claude`, `git`, and `gh` CLIs.

## Decisions (from interview)

| Topic | Decision |
|---|---|
| Driving Claude | `claude -p` subprocess, `--output-format stream-json`. No Agent SDK. |
| Workspace | Git worktree per ticket (git profiles). Non-git profiles run in profile folder. |
| Concurrency | Configurable `maxParallel` per profile. |
| Finish | If files changed and GitHub available: commit, push, open PR, move to Review. Non-code tasks: just report. Dev task without git/GitHub: move to Review as `blocked` with explanation. Claude judges. |
| Session | One Claude session per ticket, reused for all runs via `--resume`. |
| Rework | User adds comments in Review, drags to Ready; next run resumes session with new comments. |
| Terminal handoff | Copy-command buttons to resume/plan in terminal. No in-app chat. |
| Permissions | `--permission-mode bypassPermissions` for all runs. |
| Storage | Central `~/.claude-kanban/`, Markdown + YAML frontmatter, JSONL logs. |
| Columns | Backlog, Planning, Ready, In Progress, Review, Done. |
| Launch | launchd background daemon. |
| Stack | Bun + TypeScript server; React + Vite UI. |
| PR merge | Poll `gh` every 5 min; merged → Done. |
| Live view | Card shows last activity; ticket detail shows full transcript. |
| Extra fields | None for now. |

## Architecture

```
launchd ──> ckanban daemon (Bun, 127.0.0.1:7777)
             ├─ HTTP API + SSE  <── React/Vite UI (browser)
             ├─ dispatch(profile): event-driven, Ready → spawn up to N `claude -p`
             ├─ Runner: spawn, parse stream-json → activity.jsonl + SSE
             ├─ PR poller: every 5 min `gh pr view` on Review cards with prUrl
             └─ Store: plain files under ~/.claude-kanban/
```

Units:

- **store** — read/write profiles, tickets, comments, activity. Atomic writes (tmp file + rename). Only module touching the filesystem layout.
- **git** — worktree add/remove, repo/remote detection, base branch detection.
- **prompts** — builds first-run, resume, and planning prompts.
- **result** — parses `CKANBAN_RESULT:` line / final `result` event.
- **runner** — spawns `claude`, streams events, handles exit/stop.
- **dispatcher** — `dispatch(profile)`: fills free slots from Ready queue.
- **prPoller** — timer, checks PR state via `gh`.
- **events** — in-process pub/sub feeding SSE.
- **http** — Bun server: API routes, SSE, static UI, localhost guard.
- **cli** — `ckanban dev|install|uninstall|open`.
- **ui** — React app.

## Data layout

```
~/.claude-kanban/                  (override: env CKANBAN_HOME)
  config.json                      { port: 7777, prPollMinutes: 5 }
  daemon.log
  profiles/<slug>/
    profile.json                   { name, slug, path, baseBranch, maxParallel, model?, createdAt }
    tickets/<id>/
      ticket.md
      comments.jsonl               {id, author: "user"|"ai", text, at}
      activity.jsonl               {run, at, event}  (raw stream-json event per line)
```

`ticket.md`:

```markdown
---
id: t_20260929_ab12
title: Add dark mode
status: ready            # backlog|planning|ready|in_progress|review|done
order: 3                 # position within column
sessionId: 7c1e...uuid   # null until first session
worktree: /abs/path      # null until created / non-git
branch: ck/t_20260929_ab12-add-dark-mode
prUrl: null
outcome: null            # null|done|blocked|failed|stopped
lastActivity: "Edit src/theme.ts"
lastRunAt: 2026-09-29T10:00:00Z
runCount: 1
error: null
createdAt: ...
updatedAt: ...
---
Description markdown. Claude may rewrite this during planning.
```

- Ticket id: `t_<yyyymmdd>_<4 random base36>`.
- Worktree dir: `<repoParent>/.ckanban-worktrees/<slug>/<id>`.
- Branch: `ck/<id>-<title-slug>` (title slug max 40 chars).
- Non-git profile: `worktree` stays null; cwd = profile path.
- Daemon is the single writer except Claude editing the ticket body during planning; daemon re-reads files on each request (no stale cache).

## Run lifecycle

### Dispatch (event-driven, no scheduler loop)

`dispatch(profile)` is called when:

- a ticket is moved into / created in Ready
- a run finishes (slot frees)
- `maxParallel` changes
- daemon starts

It starts runs while `running(profile) < maxParallel`, picking Ready tickets by `order` ascending. Cards arriving while all slots are busy wait in Ready and start as soon as a slot frees.

### Spawn

For git profiles on first session: `git worktree add -b <branch> <dir> <baseBranch>`.

```
cd <worktree or profile path>
claude -p "<prompt>" --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  (--session-id <uuid> | --resume <uuid>) [--model <profile.model>]
```

Binary configurable via env `CKANBAN_CLAUDE_BIN` (tests use a fake).

Claude sessions are keyed by cwd, so the worktree is created on the ticket's first session (planning or run) and every later session uses the same dir.

### Prompts

- **First run:** title + description + rules: work in this directory; if the task changes files and this is a git repo with a GitHub remote, commit, push the branch, `gh pr create`, print the PR URL; if the task needs code changes but git/GitHub is unavailable, do not fake it — explain the problem; non-code task: do it and report the result. End with a single line `CKANBAN_RESULT: {"status":"done"|"blocked","prUrl":string|null,"summary":string}`.
- **Resume run:** "User feedback since last run:" + comments with `at > lastRunAt` + "Continue. Update the existing PR if one exists." + same result-line rule.
- **Planning (terminal):** title + description + path to `ticket.md`; "We are planning, do not implement. Discuss with the user. When the plan is agreed, rewrite the body of ticket.md (keep frontmatter untouched) with the refined plan."

### Live activity

Each stream-json line → appended to `activity.jsonl` and published over SSE. `lastActivity` derived from latest event: tool use → `"<Tool>: <short arg>"` (e.g. `Edit src/app.ts`, `Bash: npm test`), assistant text → first 80 chars. Throttled writes to `ticket.md` (≤1/sec).

### Finish

On process exit:

1. Parse result line from the final `result` event text (fallback: last assistant text).
2. Exit 0 + result → `outcome` = result status; `prUrl` saved if present; summary posted as AI comment.
3. Exit 0, no result line → `outcome: done`, final text as AI comment.
4. Nonzero exit / spawn error → `outcome: failed`, `error` = stderr tail (last 2 KB).
5. Status → `review` in all cases. `lastRunAt` = run start time. `runCount++`. Call `dispatch(profile)`.

### Stop

Stop button → SIGTERM (SIGKILL after 5 s) → `outcome: stopped`, status `review`.

### Rework loop

User comments in Review, drags to Ready → resume run with new comments.

### Terminal handoff

- "Copy resume command": `cd '<dir>' && claude --resume <uuid>` — shown when `sessionId` exists, disabled while `in_progress`.
- "Copy planning command" (Backlog/Planning cards): ensures worktree + sessionId exist, then `cd '<dir>' && claude --session-id <uuid> '<planning prompt>'` (or `--resume` if session already exists).
- Moving a card to Ready while the user is still in a terminal session on it is the user's responsibility; UI shows a hint.

### PR poller

Every `prPollMinutes`, for Review tickets with `prUrl`: `gh pr view <url> --json state`. `MERGED` → status `done`, remove worktree (branch kept). `CLOSED` → AI comment "PR closed", stays in Review. "Check PR now" button triggers same check for one ticket.

### Done cleanup

Manually moving to Done removes the worktree if `git status --porcelain` is clean; otherwise keeps it and posts a warning comment.

### Crash recovery

On daemon start, any `in_progress` ticket → `ready` with comment "Interrupted by daemon restart; resuming." Then `dispatch` each profile. Resume run uses `--resume` if `sessionId` exists.

## UI

- Top bar: profile switcher; New profile (name, path, baseBranch auto-detected from `git symbolic-ref refs/remotes/origin/HEAD` fallback current branch, maxParallel default 1, optional model). Health banner if `claude`/`git`/`gh` missing or profile path missing.
- Board: 6 columns, drag-and-drop with `@dnd-kit` (between and within columns). Card: title, last activity, badges (running spinner, PR link, blocked amber, failed red, stopped grey).
- New ticket: title + markdown description, target column (default Backlog).
- Ticket drawer: editable title/description, transcript (live, tool calls collapsed, cost/duration footer), comments list + box, actions: Copy resume/planning command, Stop, Open PR, Check PR now, Delete.
- Single SSE stream `/api/events` for all live updates.

## API

```
GET    /api/health                               tool availability
GET    /api/profiles           POST /api/profiles
PATCH  /api/profiles/:p        DELETE /api/profiles/:p   (board data only; never repo)
GET    /api/profiles/:p/tickets                  POST /api/profiles/:p/tickets
GET    /api/profiles/:p/tickets/:id
PATCH  /api/profiles/:p/tickets/:id              {title?, body?, status?, order?}
DELETE /api/profiles/:p/tickets/:id
GET    /api/profiles/:p/tickets/:id/activity
GET    /api/profiles/:p/tickets/:id/comments     POST .../comments {text}
POST   /api/profiles/:p/tickets/:id/stop
POST   /api/profiles/:p/tickets/:id/check-pr
POST   /api/profiles/:p/tickets/:id/planning-command   → {command}
GET    /api/events                               SSE: ticket.updated, ticket.deleted, activity, profile.updated
```

## Security

Runs use `bypassPermissions`, so the daemon can execute arbitrary commands. Therefore:

- Bind to `127.0.0.1` only.
- Reject requests whose `Host` is not `localhost:<port>`/`127.0.0.1:<port>`, and mutating requests whose `Origin` (if present) is not the same origin. Blocks DNS rebinding and cross-site requests from malicious pages.

## Daemon / CLI

- `ckanban dev` — run server in foreground.
- `ckanban install` — write `~/Library/LaunchAgents/io.ckanban.daemon.plist` (RunAtLoad, KeepAlive, stdout/stderr → `~/.claude-kanban/daemon.log`, PATH captured from the installing shell so `claude`/`gh`/`git` resolve), then `launchctl bootstrap`.
- `ckanban uninstall` — `launchctl bootout` + remove plist.
- `ckanban open` — open browser to the board.

## Error handling

- Missing `claude`/`git`/`gh` → health banner; dispatch still attempts and fails the ticket with a clear error.
- Worktree creation failure → ticket to Review, `outcome: failed`, error message.
- Profile path missing → profile flagged, dispatch skipped for that profile.
- Corrupt `ticket.md` → ticket listed with error badge, not dispatched; other tickets unaffected.

## Testing

`bun test`.

- Unit: store (atomic write, frontmatter round-trip), dispatcher (slot limits, ordering), result parser, prompt builder, lastActivity derivation, localhost guard.
- Integration: fake `claude` script via `CKANBAN_CLAUDE_BIN` emitting canned stream-json, against a temp git repo and temp `CKANBAN_HOME`. Covers pickup, finish w/ PR URL, blocked, failure, resume with comments, stop, crash recovery.
- UI: manual browser check.

## Out of scope (now)

In-app chat, labels/priority/per-ticket model, webhooks, multi-user, non-macOS daemon install.
