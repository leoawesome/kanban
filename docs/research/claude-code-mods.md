# Claude Code mods: can the kanban board live inside Claude Code?

Date: 2026-10-03. Claude Code build checked: `2.1.288`. The mod API is early access ("this surface may change between releases without notice"), so re-check before building.

## TL;DR

**Verdict: partial, but a usable board is possible.** A mod can open a pane inside Claude Code (terminal and desktop Code tab) that shows a live multi-column board read from our daemon, with clickable cards, buttons, text inputs and selects. Drag and drop is possible on terminal and desktop through a `Client` region that gets raw pointer events. A probe mod showing all of this validated and passed `claude plugin test` on every surface.

What a mod **cannot** do: run our React app, show HTML, or embed/iframe `http://localhost:7777`. The UI is a fixed set of elements (`Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Code`, `Link`, plus `Svg` and `Client` on some surfaces), laid out like Ink/flexbox in monospace cells. So it is a **second, simpler UI** written against that element set, not our current board moved over.

**Recommendation:** keep the web UI as the main board. Build a small **companion mod** (option B below): a `/board` pane with a compact board and quick actions, a status line counting running tickets, and toasts when a ticket finishes or needs input. Effort M. Only do the full drag-and-drop board (option A) if the companion gets daily use.

## How mods work (short)

- A mod is a plugin folder: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming one module, `hooks/register.tsx` exporting `register(on, options)`.
  Source: `plugin-authoring` skill (`SKILL.md`, `reference.md`).
- Every hook is `($, e, next)`. `$` is the engine interface (`$.ui`, `$.http`, `$.process`, `$.fs`, `$.state`, `$.store`, `$.clock`, ...). The module runs with **no DOM and no Node**; everything outside goes through `$`.
  Source: `plugin-authoring/types/claude-code.d.ts` header.
- UI is JSX drawn from the surface's element table: `const { Box, Text, Button } = $.ui.resolve(e)`, where `e.surface` is `terminal`, `desktop`, `vscode` or `mobile`.
- Blog: <https://claude.com/blog/claude-code-mods>. Mods are not sandboxed and have full machine access.

## Answers

### 1. UI surfaces: what can a pane render?

Element tables per surface (`claude-code.d.ts`, `export type Elements`):

| Surface | Elements |
| --- | --- |
| terminal | Box, Text, Button, Input, Select, Link, Code, Markdown, **Client**, Raster, Image |
| desktop (Code tab) | Box, Text, Button, Input, Select, **Svg**, Link, Code, Markdown, **Client** |
| vscode | same as desktop, without Client |
| mobile | Box, Text, Button, Svg, Link, Code, Markdown (no Input/Select) |

- **Structured components, not HTML.** Flexbox-style `Box` layout, styled `Text`, `Button` with `variant`, hover styles on `Box`.
- **No webview, no iframe, no React DOM.** The only HTML-ish element is `Svg`: shown as an image, or with `isInteractive` in a sandboxed frame that "never enables script or event-handler attributes". It cannot load our app.
- **`Client`** (terminal + desktop): a region drawn by a separate module of the plugin, with its own state, a frame timer, key events and pointer events in cells. This is the escape hatch for custom widgets such as drag and drop.
- `Link` accepts `https:` or `http://localhost`, so a card can deep-link to `http://localhost:7777/...` to open the full web UI.

Verified by experiment (below) for the board layout. **Not verified:** how the desktop app actually paints a pane (colours, fonts, real pixel size). The test kit checks the tree against each surface's rules, not the paint.

### 2. Interaction

- **Clicks:** yes, `Button.onPress` on all four surfaces (`ui.press` event). Verified.
- **Forms:** `Input` (`onInput` / `onSubmit`) and `Select` on terminal, desktop, vscode. None on mobile yet.
- **Keyboard:** `Client` gets `onKey` after a click gives it focus. Panes can take focus (`focus: true`, `closeOnEscape`).
- **Drag and drop:** no built-in drag. Can be built with `Client.onPointer` (`down` / `move` / `up` with capture, column/row in cells), then `surface.post(data)` sends the drop to the hooks module, which calls our API. Verified in the test kit on terminal and desktop: down on column 0, up on another column produced a `ui.message` with `{from, to}`. Not available on vscode/mobile (no `Client`).
- **Live updates:** yes. `$.clock.every` (hooks module) or `surface.every` (Client) can poll `$.http.fetch`. A `$.state` write redraws only the readers. **SSE:** `$.http.fetch` resolves after the whole body is read, so it can't consume our `text/event-stream` (`src/server/http.ts:714`). A streaming `$.process.spawn` (e.g. `curl -N`) could work around that. Not tested. Polling every 2-5 s is simpler.

### 3. Size and layout

- `$.ui.open({ id, title, rows, columns })`. `rows` is the height wanted when the pane sits **inline above the prompt** (default a third of the screen). `columns` is the width wanted when **docked beside a fullscreen transcript** (docking from 110 columns). Both are requests: a size the person dragged wins.
- A pane the person opened (slash command, button) is placed at any width. One opened unasked (session start, timer) waits until the terminal is 144 columns wide.
- Six columns at ~20-25 cells each need ~130-150 cells. That fits a wide terminal or the desktop dock, but card titles must be cut to ~20 characters. A compact list (one column, grouped by status) fits anywhere.
- Source: `PaneOpenArgs` and `$.ui.open` docs in `claude-code.d.ts`.

### 4. Data access

- **HTTP:** `$.http.fetch(url, { method, headers, body })` goes through the host to "whatever the host reaches", so `http://localhost:7777/api/...` works (an org web-fetch policy could block it). The probe calls `GET /api/profiles/kanban/tickets` (real endpoint, returns the ticket list).
- **Files:** `$.fs` can read `~/.claude-kanban/` directly, but the API is the better contract (no duplicate parsing of our storage).
- **Commands:** `$.process.run/spawn` (CLI only) could call `ckanban` CLI commands.
- Mutations (move, create, comment) map onto our existing HTTP routes. The ckanban MCP tools stay the way for *Claude* to manage tickets. The mod is only for the *person's* UI.

### 5. Ticket runs (`claude -p`)

- Mods do load in `-p` runs: "A headless `claude -p` always loads fresh" (`reference.md`) via `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`. No UI is drawn (`$.session.surfaces()` is empty in a plain `-p` run).
- Possibly useful later, not needed now: `tool.call` hooks for permission rules per ticket, `prompt.compose` to inject board context instead of prompt text, `$.http.fetch` to report progress live to the daemon. Today we start runs without `--plugin-dir` (`src/` has no reference to it).

### 6. Distribution

- Ship as a plugin. Options:
  1. A folder in this repo (e.g. `mod/`) that the user loads with `claude --plugin-dir <path>` or `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` `env` (needed for the desktop app, where no flag can be given).
  2. A plugin marketplace entry (our repo as a marketplace, installed with `/plugin`), or submission to the Claude directory.
- `ckanban install` could add the `CLAUDE_CODE_PLUGIN_DIRS` entry, pointing at mod files shipped with the release (the binary would need to write them out, as it does web assets).
- The mod is a thin client: the daemon stays the single source of truth. Board works only while the daemon runs; the pane should say so when `fetch` fails.

## Experiment

Throwaway probe mod in `/tmp/ckanban-mod-probe` (not committed):

- `hooks/register.tsx`: `/board` command opens a pane (`columns: 160, rows: 30`). The `ui.render` hook fetches tickets from the daemon and draws six columns (backlog, planning, ready, running, review, done) with one `Button` per ticket, plus a `Client` drag strip on surfaces that have it.
- `hooks/drag.tsx`: `Client` module, `onPointer` down/up maps x to a column and `post`s `{from, to}`. The hooks module toasts it.
- `hooks/board.test.ts`: mocks `http.fetch`, mounts the pane on `terminal`, `desktop`, `vscode`, `mobile`, checks all six column headers, presses a card, and drags on terminal + desktop.

Results:

- `claude plugin validate`: passed (only an "author missing" warning).
- `claude plugin test`: **1 pass, 0 fail.** Toasts captured: card press on all 4 surfaces, `drop {"from":0,"to":1}` on terminal and desktop.
- Not done: loading it in a live interactive or desktop session (hot reload could not be enabled from a headless board run). So the actual look on screen is unverified.

## Options

Criteria: value to Leo (use board without the browser), effort, risk (early-access API churn, parity drift with web UI).

| Option | What | Value | Effort | Risk |
| --- | --- | --- | --- | --- |
| **B. Companion mod** (recommended) | `/board` pane: compact board or grouped list, buttons to start/stop/move, reply input for tickets in "questions"; status line "2 running, 1 needs input"; toasts on done/blocked/questions; `Link` to open the ticket in the web UI | High: covers the "glance and nudge" use without leaving Claude Code | M (2-3 days) | Medium: API early access; small surface to fix |
| A. Full board in a pane | B plus drag-and-drop columns via `Client`, ticket detail view, chat transcript, plan view | Medium: nicer, but still cell-based and below the web UI (no images, outputs preview, rich markdown layout) | L (1-2 weeks) | High: big UI on an unstable API, two UIs to keep in sync |
| C. Stay web-only | No mod; maybe a `Link`-only status line later | Low | S | Low |

## Recommendation and follow-up tickets

Go with **B**, built in small steps. Revisit A only after B is in daily use and the mod API leaves early access.

1. **Mod: status line + toasts for ticket state.** Poll `/api/profiles`; status line shows running / needs-input counts; toast when a ticket finishes, blocks or asks questions.
2. **Mod: `/board` pane with compact board.** Grouped list per status, card `Button`s open a detail row with a `Link` to the web UI and start/stop/move actions.
3. **Mod: answer ticket questions from the pane.** `Input` / `Select` to reply to a ticket in "questions" status through the existing chat API.
4. **Ship the mod with ckanban.** `ckanban install` writes the mod and sets `CLAUDE_CODE_PLUGIN_DIRS`; doc in README.
5. (Later, optional) **Drag-and-drop columns via `Client`** (option A).

## Sources

- Blog: <https://claude.com/blog/claude-code-mods>
- `plugin-authoring` skill bundled with Claude Code 2.1.288: `SKILL.md`, `reference.md`, `examples/pane.tsx`, `types/claude-code.d.ts` (`Elements`, `ClientProps`, `ClientSurface`, `ClientPointerEvent`, `SvgProps`, `LinkProps`, `PaneOpenArgs`, `$.ui.open`, `$.http.fetch`)
- Probe experiment above (`claude plugin validate`, `claude plugin test`)
- This repo: `src/server/http.ts` (SSE endpoint, ticket API)
