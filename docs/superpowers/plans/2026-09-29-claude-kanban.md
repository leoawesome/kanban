# Claude Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local kanban web UI where tickets moved to Ready are worked automatically by headless `claude -p`, one board per profile folder, all data in files.

**Architecture:** Bun daemon (`src/server`) owns file store, event-driven dispatcher, runner that spawns `claude -p --output-format stream-json`, PR poller, HTTP API + SSE. React/Vite UI (`web/`) built to `web/dist` and served statically by daemon. CLI (`src/cli.ts`) runs dev server or installs launchd agent.

**Tech Stack:** Bun 1.1+, TypeScript, `yaml` (frontmatter), React 18, Vite, `@dnd-kit/core` + `@dnd-kit/sortable`, `marked` (markdown render).

**Spec:** `docs/superpowers/specs/2026-09-29-claude-kanban-design.md`

## Global Constraints

- Data root: `process.env.CKANBAN_HOME ?? ~/.claude-kanban`.
- Claude binary: `process.env.CKANBAN_CLAUDE_BIN ?? "claude"`.
- Default port 7777, bind `127.0.0.1` only. `CKANBAN_PORT` env overrides.
- Statuses exactly: `backlog | planning | ready | in_progress | review | done`.
- Outcomes exactly: `null | done | blocked | failed | stopped`.
- Ticket id: `t_<yyyymmdd>_<4 base36>`. Branch: `ck/<id>-<titleSlug≤40>`. Worktree: `<dirname(repo)>/.ckanban-worktrees/<profileSlug>/<id>`.
- Result line prefix exactly `CKANBAN_RESULT:` followed by JSON `{status, prUrl, summary}`.
- Run flags: `-p <prompt> --output-format stream-json --verbose --permission-mode bypassPermissions` + `--session-id <uuid>` (first) or `--resume <uuid>` + optional `--model`.
- All file writes atomic (write `<file>.tmp-<rand>`, rename).
- SIGTERM on stop, SIGKILL after 5 s.
- PR poll every `config.prPollMinutes` (default 5).

## Review Focus

1. Ticket titles with quotes/colons/unicode/emoji — must round-trip through frontmatter and produce a valid branch slug (fallback `task` if slug empty). Test in Task 2 + Task 1.
2. Paths containing spaces or single quotes in copy commands — must be shell-quoted. Test in Task 4 (`shellQuote`).
3. Claude editing `ticket.md` body during planning while daemon writes frontmatter — daemon must re-read body from disk before each write, never write cached body. Test in Task 2 (`updateTicket` preserves externally changed body).
4. Stream-json lines split across stdout chunks / non-JSON lines — must buffer by newline and skip unparsable lines. Test in Task 5.
5. Moving a ticket out of `in_progress` via PATCH while running — must stop the run first, not leave orphan process. Test in Task 6.

---

### Task 1: Scaffold, types, utils

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/server/types.ts`, `src/server/util.ts`, `test/util.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `Status`, `Outcome`, `Profile {name, slug, path, baseBranch, maxParallel, model?: string|null, createdAt}`, `Ticket {id,title,status,order,sessionId,worktree,branch,prUrl,outcome,lastActivity,lastRunAt,runCount,error,createdAt,updatedAt, body}`, `Comment {id, author:"user"|"ai", text, at}`, `Config {port, prPollMinutes}`, `STATUSES: Status[]`.
  - `util.ts`: `slugify(s: string, max=40): string`, `newTicketId(now=new Date()): string`, `newId(): string` (8 base36), `shellQuote(s: string): string`, `nowIso(): string`.

- [ ] Step 1: `package.json` with scripts `dev` (`bun src/cli.ts dev`), `test` (`bun test test`), `build:web` (`cd web && bun run build`), bin `ckanban: src/cli.ts`; dep `yaml`.
- [ ] Step 2: Tests: `slugify("Add Dark Mode!")==="add-dark-mode"`; `slugify("🚀🚀")==="task"`; length ≤ 40 without trailing `-`; `newTicketId(new Date("2026-09-29"))` matches `/^t_20260929_[0-9a-z]{4}$/`; `shellQuote("a b'c")==="'a b'\\''c'"`.
- [ ] Step 3: Implement, `bun test` passes. Commit `feat: scaffold project and utils`.

### Task 2: File store

**Files:**
- Create: `src/server/store.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: types, util.
- Produces (`class Store(root: string)`):
  - `config(): Config`
  - `listProfiles(): Profile[]`, `getProfile(slug): Profile|null`, `saveProfile(p: Profile): void`, `deleteProfile(slug): void`
  - `listTickets(slug): Ticket[]` (bad file → ticket with `error:"corrupt ticket file"`, status `backlog`, skipped from dispatch by `error` starting `corrupt`)
  - `getTicket(slug, id): Ticket|null`
  - `createTicket(slug, {title, body, status}): Ticket` (order = max order in column + 1)
  - `updateTicket(slug, id, patch: Partial<Ticket>): Ticket` — re-reads file first, merges, writes; if `patch.body` undefined keeps on-disk body.
  - `deleteTicket(slug, id)`
  - `ticketPath(slug, id): string` (path of ticket.md)
  - `listComments(slug,id): Comment[]`, `addComment(slug,id,author,text): Comment`
  - `appendActivity(slug,id,run:number,event:unknown)`, `readActivity(slug,id): {run,at,event}[]`
  - export `defaultRoot(): string`
- Frontmatter format: `---\n<yaml>---\n<body>`; parse by splitting on first two `---` lines.

- [ ] Step 1: Tests (temp dir root): profile CRUD; ticket create/list/get round-trip with title `He said: "hi" — ✨`; order increments; `updateTicket` after body edited on disk via `fs.writeFile` keeps new body; comments append order; activity append/read; corrupt file listed with error.
- [ ] Step 2: Implement. Tests pass. Commit `feat: file store`.

### Task 3: Git helpers

**Files:**
- Create: `src/server/git.ts`, `test/git.test.ts`

**Interfaces:**
- Produces: `run(cmd: string[], cwd: string): Promise<{code, stdout, stderr}>`, `isGitRepo(path): Promise<boolean>`, `detectBaseBranch(path): Promise<string>` (origin/HEAD → current branch → `main`), `worktreeDir(profile: Profile, id): string`, `addWorktree(repo, dir, branch, base): Promise<void>` (throws Error with stderr), `removeWorktree(repo, dir): Promise<{removed: boolean, reason?: string}>` (refuses if `git status --porcelain` non-empty), `which(bin): Promise<boolean>`.

- [ ] Step 1: Tests in temp repo (`git init -b main`, commit): isGitRepo true/false; detectBaseBranch `main`; addWorktree creates dir on branch; removeWorktree clean → removed; dirty → `{removed:false}`.
- [ ] Step 2: Implement with `Bun.spawn`. Pass. Commit `feat: git helpers`.

### Task 4: Prompts, result parser, activity summarizer

**Files:**
- Create: `src/server/prompts.ts`, `src/server/result.ts`, `src/server/activity.ts`, `test/prompts.test.ts`

**Interfaces:**
- Produces:
  - `firstRunPrompt(t: Ticket, isGit: boolean): string`, `resumePrompt(t: Ticket, newComments: Comment[]): string`, `planningPrompt(t: Ticket, ticketFile: string): string` (content per spec "Prompts").
  - `parseResult(text: string): {status:"done"|"blocked", prUrl: string|null, summary: string} | null` — last line starting `CKANBAN_RESULT:`; invalid JSON → null.
  - `summarizeEvent(ev: any): string | null` — assistant tool_use → `"<name>: <arg>"` where arg = `input.file_path|input.command|input.pattern|input.url|input.description` basename-shortened to 60 chars; assistant text → first 80 chars; `result` → `"Finished"`; else null.
  - `extractFinalText(events: any[]): string` — `result.result` of last result event, else last assistant text.
  - `resumeCommand(dir, sessionId)`, `planningCommand(dir, sessionId, prompt, exists: boolean)` using `shellQuote`.

- [ ] Step 1: Tests: parseResult of text with result line mid-output (last wins), with no line → null, bad JSON → null; summarizeEvent Edit/Bash/text; resumeCommand with path `/tmp/a b` quoted; firstRunPrompt contains title, body, `CKANBAN_RESULT:`; resumePrompt contains each comment text.
- [ ] Step 2: Implement. Pass. Commit `feat: prompts, result parsing, activity summary`.

### Task 5: Event bus + runner

**Files:**
- Create: `src/server/events.ts`, `src/server/runner.ts`, `test/fixtures/fake-claude.ts`, `test/runner.test.ts`

**Interfaces:**
- Produces:
  - `events.ts`: `class Bus { on(fn:(e: BusEvent)=>void): ()=>void; emit(e: BusEvent) }`, `BusEvent = {type:"ticket.updated", profile, ticket} | {type:"ticket.deleted", profile, id} | {type:"activity", profile, id, run, event} | {type:"profile.updated", profile: Profile|null, slug}`.
  - `runner.ts`: `startRun(opts: {bin, cwd, args: string[], onEvent:(ev:any)=>void}): RunHandle`, `RunHandle { done: Promise<{code:number, stderr:string, events:any[]}>, stop(): void, stopped: boolean }`. Line-buffered stdout parsing; non-JSON lines ignored; stderr tail 2 KB.
  - `buildArgs(prompt, sessionId, resume: boolean, model?: string|null): string[]`.
- Fake claude: bun script reading `FAKE_MODE` env (`ok` emits init/assistant tool_use/assistant text with result line containing `FAKE_PR` env/result, exit 0; `fail` writes stderr exit 1; `slow` sleeps 30 s). Writes all argv to `$FAKE_ARGS_FILE` if set. Emits one JSON line in two chunks to test buffering.

- [ ] Step 1: Tests: ok mode collects events, onEvent called per event, code 0; fail → code 1 & stderr tail; slow + stop() → resolves within 7 s, `stopped` true; buildArgs contains `--session-id` vs `--resume`.
- [ ] Step 2: Implement. Pass. Commit `feat: runner and event bus`.

### Task 6: Board service (dispatcher, lifecycle)

**Files:**
- Create: `src/server/board.ts`, `test/board.test.ts`

**Interfaces:**
- Consumes: Store, Bus, git, prompts, result, activity, runner.
- Produces `class Board(store, bus, opts: {claudeBin: string})`:
  - `dispatch(slug): void` — start runs while running < maxParallel, ready tickets by order, skip corrupt, skip if profile path missing.
  - `running(slug): number`
  - `createTicket(slug, input)`, `updateTicket(slug, id, patch)` — handles status transitions: →ready dispatch; in_progress→other: stop run first; →done: removeWorktree, comment warning if dirty; emits `ticket.updated`.
  - `deleteTicket(slug,id)` (stops run, removes worktree best effort)
  - `addComment(slug,id,text)`
  - `stop(slug,id)`
  - `ensureSession(slug,id): Promise<{dir, sessionId, existed: boolean}>` (creates worktree if git and missing; assigns uuid)
  - `planningCommand(slug,id): Promise<string>`
  - `recover(): void` — in_progress → ready + comment "Interrupted by daemon restart; resuming.", then dispatch all.
  - `whenIdle(): Promise<void>` (test helper: resolves when no runs active)
- Run completion per spec "Finish" (outcome, prUrl, AI comment, error stderr tail, status review, lastRunAt = start, runCount++, dispatch). Resume uses comments with `author==="user"` and `at > lastRunAt`. `lastActivity` write throttled to 1/s plus final flush.

- [ ] Step 1: Tests with fake claude + temp git repo profile: ready ticket runs → review, outcome done, prUrl from FAKE_PR, worktree exists, AI comment present; maxParallel 1 with 2 ready (slow) → running 1; fail → outcome failed + error; blocked result → outcome blocked; second run after user comment uses `--resume` and prompt includes comment (via FAKE_ARGS_FILE); PATCH in_progress→backlog stops run; recover moves in_progress → ready; non-git profile runs with cwd = path, worktree null.
- [ ] Step 2: Implement. Pass. Commit `feat: board dispatcher and run lifecycle`.

### Task 7: PR poller

**Files:**
- Create: `src/server/prpoller.ts`, `test/prpoller.test.ts`

**Interfaces:**
- Produces: `checkPr(board: Board, slug, id, gh = ghState): Promise<void>`, `ghState(url): Promise<"OPEN"|"MERGED"|"CLOSED"|null>`, `startPoller(board, store, minutes): () => void`.
- MERGED → `board.updateTicket(... {status:"done"})`; CLOSED → AI comment "PR closed without merge." once (skip if last AI comment same).

- [ ] Step 1: Tests with injected gh fn: MERGED → done; CLOSED → comment, stays review; OPEN → unchanged.
- [ ] Step 2: Implement. Pass. Commit `feat: PR merge poller`.

### Task 8: HTTP server

**Files:**
- Create: `src/server/http.ts`, `src/server/main.ts`, `test/http.test.ts`

**Interfaces:**
- Produces: `createServer({store, bus, board, port, webDir}): Server` (Bun.serve on 127.0.0.1), `isAllowedRequest(req, port): boolean`, `startDaemon(): Promise<void>` in main.ts (store, bus, board, recover, poller, serve).
- Routes exactly per spec "API". `POST /api/profiles` body `{name, path, maxParallel?, model?, baseBranch?}` → slug from name (unique suffix), baseBranch auto-detected if git. `GET /api/health` → `{claude, git, gh: boolean}`. SSE `/api/events` with `data: <json>\n\n` and 15 s `: ping`. Non-/api paths serve `webDir` files, fallback index.html.

- [ ] Step 1: Tests (port 0): Host `evil.com` → 403; POST with Origin `http://evil.com` → 403; create profile + ticket via API, PATCH status, GET list; 404 unknown ticket.
- [ ] Step 2: Implement. Pass. Commit `feat: HTTP API and SSE`.

### Task 9: CLI + launchd

**Files:**
- Create: `src/cli.ts`, `src/server/launchd.ts`, `test/launchd.test.ts`

**Interfaces:**
- Produces: `plistXml({bunPath, cliPath, path, logFile, home}): string`; commands `dev`, `start` (same as dev, used by launchd), `install`, `uninstall`, `open`.
- Label `io.ckanban.daemon`; plist at `~/Library/LaunchAgents/io.ckanban.daemon.plist`; install runs `launchctl bootout gui/<uid>/io.ckanban.daemon` (ignore error) then `launchctl bootstrap gui/<uid> <plist>`.

- [ ] Step 1: Test plistXml contains label, KeepAlive, PATH value, ProgramArguments bun + cli + `start`.
- [ ] Step 2: Implement. Pass. Commit `feat: CLI and launchd install`.

### Task 10: Web UI

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/Board.tsx`, `web/src/Card.tsx`, `web/src/TicketDrawer.tsx`, `web/src/Transcript.tsx`, `web/src/ProfileDialog.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: HTTP API + SSE from Task 8.
- `api.ts`: typed fetch wrappers + `subscribe(fn)` over `EventSource("/api/events")`.
- Vite dev proxy `/api` → `http://127.0.0.1:7777`.
- Per spec "UI": profile switcher (remember last in localStorage), health banner, 6 columns with dnd-kit sortable (drop computes new `order` = midpoint via PATCH `{status, order}`), card badges, new ticket dialog, drawer with transcript/comments/actions (copy via `navigator.clipboard`).

- [ ] Step 1: Build `cd web && bun install && bun run build` succeeds, `tsc --noEmit` clean.
- [ ] Step 2: Commit `feat: web UI`.

### Task 11: End-to-end verification + README

**Files:**
- Create: `README.md`

- [ ] Step 1: Start `bun src/cli.ts dev` with temp `CKANBAN_HOME` and fake claude; via browser create profile, ticket, drag to Ready, observe review + transcript + comment + resume.
- [ ] Step 2: Real smoke: one real `claude` run on non-git temp folder ticket ("create hello.txt with 'hi'").
- [ ] Step 3: README (install, usage, security note). Commit `docs: README`, push.
