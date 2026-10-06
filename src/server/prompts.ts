import { readdirSync } from "node:fs";
import { join } from "node:path";
import { helperCommand } from "./artifact";
import { MOCKUPS_DIR } from "./mockups";
import { MAX_RETRIES } from "./plan";
import type { Comment, Ticket, TicketQuestion } from "./types";
import { shellQuote } from "./util";

const RESULT_RULE = `When you finish this run, end your final message with exactly one line in this format (valid JSON, single line):
CKANBAN_RESULT: {"status":"done"|"blocked"|"questions","prUrl":<string or null>,"summary":"<1-3 sentence summary for the user>"}
- "questions": you are waiting for the user's answers (ask them with the ask_questions tool in this final turn).
- "blocked": you cannot continue without something from the user (explain what in summary).
- "done": the task is complete.`;

/** Keeps fallback blocks readable: the board parses the JSON right after the opening tag. */
const BLOCK_RULE = "End the block with its own closing tag exactly as shown, and never write a board tag (like the closing tag) inside the JSON text.";

/** The planning tools may be deferred: Claude has to load them before the first call. */
const TOOL_NOTE = "(ckanban MCP tool; if it's deferred, load it with ToolSearch first)";

/** How Claude asks questions so the board can render them as a clickable form. */
export const QUESTIONS_FORMAT = `To ask the user questions, call the \`ask_questions\` tool ${TOOL_NOTE}, e.g. questions: [{"question":"Who will read the result?","options":[{"label":"My manager","description":"decision-oriented, 1 page","recommended":true},{"label":"Engineering team","description":"technical depth"}],"multiSelect":false}]
The board shows them as a form (the user can also add free text) and sends the answers back as the user's next message. Rules: at most 5 questions per round, 2-4 options each, mark exactly one option "recommended", set "multiSelect": true only when several options can apply. If the tool returns an error, fix the input and call it again. Put a one-line intro in your reply; don't repeat the questions as plain text. After the call, end your turn.
Only if the ckanban tools aren't available: put the same JSON array in ONE <ckanban-questions>[...]</ckanban-questions> block in your message instead. ${BLOCK_RULE}`;

/** How Claude proposes an improved ticket so the board can show an Apply button. */
export const TICKET_FORMAT = `To propose an improved ticket, call the \`propose_ticket\` tool ${TOOL_NOTE} with title (short, specific, under 80 characters) and description (markdown: ## Goal, ## Context, ## Scope with **In:** / **Out:**, ## Requirements, ## Acceptance criteria, ## Open questions).
The board shows it as a card; the user clicks Apply to replace the ticket's title and description. If the tool returns an error, fix the input and call it again.
Only if the ckanban tools aren't available: put {"title":"...","description":"..."} in ONE <ckanban-ticket>{...}</ckanban-ticket> block in your message instead. ${BLOCK_RULE}`;

/** How a planner ticket's chat proposes splitting the work into new tickets; the user creates them by clicking. */
export const TICKETS_FORMAT = `When the user wants to split the work into separate tickets (this ticket as the planner), first call the ckanban \`list_tickets\` tool to avoid duplicates, then call the \`propose_tickets\` tool ${TOOL_NOTE}, e.g. tickets: [{"key":"api","title":"Short, specific title (under 80 characters)","description":"## Goal\\n...\\n\\n## Context\\n...\\n\\n## Acceptance criteria\\n- ..."},{"key":"ui","title":"...","description":"...","dependsOn":["api"]}]
Each description must be self-contained (goal, context with relevant files, acceptance criteria): another Claude session works on it later without this chat. "key" is a short unique name; "dependsOn" lists the keys that must be finished first. Give a dependency to tickets that build on each other or likely edit the same files, so they don't run at the same time and conflict. The board shows one card per ticket; the user clicks Create to add it to Backlog, linked to this ticket, and can then press Start plan: the board runs the tickets in dependency order and wakes you only when one needs a decision. You cannot create tickets yourself here. If the tool returns an error, fix the input and call it again.
Only if the ckanban tools aren't available: put the same JSON array in ONE <ckanban-tickets>[...]</ckanban-tickets> block in your message instead. ${BLOCK_RULE}`;

/** How a ticket chat offers to branch the ticket; the user's click on the card does the branching. */
export const BRANCH_FORMAT = `If the user asks to branch this ticket (fork the conversation, try another direction in parallel without losing this one), call the \`propose_branch\` tool ${TOOL_NOTE} with a one-line reason. The board shows a Branch button; the user's click creates "Branch: <title>" in Planning with a copy of this conversation and its own git branch off this ticket's branch (committed work only). Don't create tickets or start the other direction yourself; after the call, end your turn.`;

function context(note: string, body: string, attrs: Record<string, string> = {}): string {
  const extra = Object.entries(attrs).map(([k, v]) => ` ${k}="${v.replace(/"/g, "'")}"`).join("");
  return `<ckanban-context note="${note.replace(/"/g, "'")}"${extra}>\n${body}\n</ckanban-context>`;
}

/** Board runs can talk to other tickets' Claude sessions (ask_ticket / reply_ticket). */
const PEERS_RULE = `# Other tickets
- If you need something only another ticket's Claude knows (what it changed and why, an API it is building), read that ticket with the ckanban \`get_ticket\` tool first. If that isn't enough, ask its Claude with \`ask_ticket\` (same board only); the call waits for the reply.
- If another ticket's Claude asks you something, reply with \`reply_ticket\` and the question id it gave you.`;

const quote = (s: string, max = 200) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * A question from ticket `from`'s Claude, sent into ticket `to`'s session (steering its run, or starting a reply).
 * The question comes first so the chat shows it; the from/question attributes mark it as a ticket-to-ticket message.
 */
export function askPrompt(from: Ticket, q: TicketQuestion): string {
  return `${q.text.trim()}

${context("", `(Question from the Claude working on ticket ${from.id} "${from.title}" on this board; question id ${q.id}. That session is waiting for your reply.)
Reply with the ckanban \`reply_ticket\` tool (questionId "${q.id}"): answer from what you know about this ticket, its conversation and its code, or ask a clarifying question back if you need more detail. Keep it short and specific.
If you were in the middle of work, carry on with it afterwards and keep following the instructions you were given for that run, including how to end it. Otherwise just reply; don't change files for this.`, { from: from.id, question: q.id })}`;
}

/** A reply that arrived after the asker's ask_ticket call stopped waiting, sent into the asker's run. */
export function lateReplyPrompt(to: Ticket, q: TicketQuestion): string {
  return `${(q.reply ?? "").trim()}

${context("", `(Reply from the Claude working on ticket ${to.id} "${to.title}" to your question ${q.id}: "${quote(q.text)}". It came after your ask_ticket call stopped waiting. Take it into account and carry on; keep following the instructions you were given for this run, including how to end it.)`, { from: to.id, reply: q.id })}`;
}

/** The same late reply as a comment, for the asker's next run. */
export function lateReplyComment(to: Ticket, q: TicketQuestion): string {
  return `Reply from ticket ${to.id} "${to.title}" to the question "${quote(q.text)}" (${q.id}):\n\n${(q.reply ?? "").trim()}`;
}

const INTERVIEW = `# How to work: interview first
The user wants to be interviewed before you do the work. In this first run:
1. Gather just enough context to ask good questions: read the ticket, its links, relevant code, docs and notes. Do NOT produce the deliverable yet.
2. Find what is unclear and would change the result: the goal (why is this wanted, who asked), the audience, the deliverable and its format, what "good" looks like (criteria), scope and depth, constraints, deadline.
3. Ask your questions with the ask_questions tool (below).
4. End with status "questions".
Only skip the interview if the ticket already answers all of this; then write the brief (below) and do the task.

${QUESTIONS_FORMAT}`;

const AFTER_ANSWERS = `If you were interviewing the user and have not started the work yet:
- If the answers still leave gaps that would change the result, ask a short follow-up round (same format, status "questions").
- Otherwise start your reply with a "Brief" section (3-6 bullets: goal, audience, deliverable, criteria, scope), then do the task.
- "go", "just do it" or similar means: use your recommended options and proceed.

${QUESTIONS_FORMAT}`;

function deliverableRule(outputDir: string): string {
  return `# Deliverables
- Outputs folder for this ticket: ${outputDir}
- For research, analysis, planning or writing tasks, save the deliverable there as a well-structured Markdown file (for example report.md). Start with a short TL;DR and a clear recommendation, then the details. The user reads files in this folder from the board.
- Quantify when you can reach real data (code, logs, analytics, cost dashboards, docs). Say where each number comes from and label estimates as estimates.
- Judge options against explicit criteria (e.g. value, cost, effort, risk) and end with concrete next steps.
- If you also publish the deliverable somewhere (e.g. as an artifact or doc), include the link in your summary.
- Code changes still belong in the repository, not in the outputs folder.`;
}

/** Board runs are headless, where Claude Code turns the Artifact tool off; the helper stands in. */
function artifactRule(): string {
  const cmd = helperCommand();
  return `# claude.ai artifacts
The Artifact tool is not available in board runs. To publish or read a claude.ai artifact, run this helper with Bash instead (each call can take a minute or two):
- New page: \`${cmd} artifact publish <file.html> [--title "Title"]\`
- Update an existing artifact (keeps the same link): first \`${cmd} artifact read <url> --out <file.html>\`, edit that file, then \`${cmd} artifact publish <file.html> --url <url>\`
- Read one: \`${cmd} artifact read <url> --out <file.html>\`
Include the printed URL in your summary.`;
}

/** Planning chats can't run the Bash helper (plan mode), so they reach artifacts through the ckanban MCP tools. */
const PLANNING_ARTIFACT_RULE = `# claude.ai artifacts
The Artifact tool is not available here. To read, update or publish a claude.ai artifact, use the ckanban MCP tools (each call can take a minute or two). Publishing artifacts is allowed while planning; it is the one exception to not changing anything:
- Read one: \`read_artifact\` with its url returns the page source.
- Update one (keeps the same link): \`read_artifact\` it, edit the HTML, then \`publish_artifact\` with the full edited page and the same url.
- New page: \`publish_artifact\` with a complete HTML document (and a title).
Reply with the printed URL.`;

/** Planning chats draw HTML mockups for UI work as reply blocks; the board saves them for the Outputs tab. */
function mockupsRule(outputDir: string): string {
  const dir = join(outputDir, MOCKUPS_DIR);
  return `# Mockups for UI work
If this ticket changes a user interface, show the user what you mean before the ticket is final:
- Make self-contained HTML mockups: one complete HTML document each, inline CSS and JS, no external network needed, realistic content, matching the project's existing look if there is one (read its styles first).
- You can't write files while planning. Put each mockup in your reply as a block like this; the board saves it to ${dir}/<name> and hides it from the chat:
<ckanban-mockup name="a-compact.html">
<!doctype html>
<html>...</html>
</ckanban-mockup>
- You decide how many variants are useful (often 2-5). Name them <letter>-<short-name>.html (letters, digits, dashes). Reuse a name to replace that mockup.
- Next to the blocks, list the mockups in plain text, one line each saying how they differ. The user previews them in the ticket's Outputs tab.
- Then ask for feedback with ONE ask_questions call, one question per design decision: alternatives for the same decision (e.g. a vs b) are options of one question; a mockup with no alternative gets its own question (e.g. "Board without the Ready column: OK?" with options like "Looks good" / "Needs changes"). Give each option that shows a mockup a "mockup" field with its file name, e.g. {"label":"a: two buttons","mockup":"a-two-buttons.html"}; the form shows a Preview link for it. Tell the user they can add a note to any question and nothing is sent until they submit.
- When answers ask for changes, resend those mockups (same name) and ask again, only about the decisions still open.
- Don't propose the final ticket for UI work until every decision has a chosen mockup, unless the user says to skip mockups. The proposed ticket must list the chosen mockups by absolute path (${dir}/<name>) under a "Target design" heading.
- Skip mockups for tickets with no UI change.`;
}

/** Runs of a ticket that has planning mockups build the ones its Target design names. */
function targetDesignRule(outputDir: string): string {
  const dir = join(outputDir, MOCKUPS_DIR);
  let html = false;
  try {
    html = readdirSync(dir).some((f) => /\.html?$/i.test(f));
  } catch {}
  if (!html) return "";
  return `# Target design
This ticket has HTML mockups from planning in ${dir}. The ticket's "Target design" names the ones the user chose: read those before changing the UI and match them closely (layout, wording, states); mention in your summary if you had to deviate and why. Ignore mockups the ticket doesn't name.

`;
}

export interface PromptContext {
  isGit: boolean;
  linked?: boolean;
  comments?: Comment[];
  outputDir: string;
  /** The ticket was created by this schedule (null name: schedule since deleted). */
  schedule?: { id: string; name: string | null; board: string };
}

/** Tells a scheduled run where it came from, so it can read or refine its own schedule. */
function scheduleNote(s: PromptContext["schedule"]): string {
  if (!s) return "";
  if (s.name === null) return `\nThis ticket was created by schedule ${s.id} on board ${s.board}, which has since been deleted.\n`;
  return `\nThis ticket was created by schedule ${s.id} ("${s.name}") on board ${s.board}; it creates a new ticket like this on its own timetable. ` +
    `You can read or change that schedule (for example refine its prompt for future runs) with the ckanban tools list_schedules, schedule_history and update_schedule.\n`;
}

export function firstRunPrompt(t: Ticket, ctx: PromptContext): string {
  const interview = t.mode === "interview";
  const comments = ctx.comments ?? [];
  const intro = ctx.linked
    ? `This conversation is now linked to a kanban ticket and continues from the board. Use everything above as context and carry the ticket forward.`
    : interview
    ? `You are working a kanban ticket from a board. The user is not watching live; they reply through ticket comments between runs.`
    : `You are an autonomous agent working a kanban ticket. No human is watching; do not ask questions, make reasonable decisions.`;
  const where = ctx.linked
    ? `You are working in the main checkout of this project (not an isolated worktree). If you change code, create or reuse a feature branch; never commit directly to the default branch.`
    : ctx.isGit
    ? `You are working in a dedicated git worktree on branch for this ticket.`
    : `You are working in a folder that is NOT a git repository.`;
  return context("Board started work on the ticket", `${intro}

# Ticket: ${t.title}

${t.body.trim() || "(no description)"}
${scheduleNote(ctx.schedule)}${comments.length ? `\n# User notes\n${comments.map((c) => `- ${c.text}`).join("\n")}\n` : ""}
${interview ? `${INTERVIEW}\n\n` : ""}# Rules
- ${where}${t.parentId && ctx.isGit && !ctx.linked ? `
- This ticket is part of a plan (planner ticket ${t.parentId}): earlier tickets of the plan may have landed on the remote base branch after this worktree was created. Before you start, \`git fetch\` and rebase this branch onto the remote base branch.` : ""}
- Decide whether this task requires changing files in a code project.
- If it changes files and this is a git repo with a GitHub remote: commit your changes, push the branch, open a pull request with \`gh pr create\`, and include the PR URL in the result line.
- If it is a development task but git or a GitHub remote is not available, do NOT fake it. Stop, and report status "blocked" explaining what is missing.
- If it is a non-code task (research, writing, analysis, file organisation), no PR is needed.

${PEERS_RULE}

${targetDesignRule(ctx.outputDir)}${deliverableRule(ctx.outputDir)}

${artifactRule()}

${RESULT_RULE}`);
}

export function resumePrompt(t: Ticket, newComments: Comment[], outputDir: string): string {
  const feedback = newComments.length
    ? newComments.map((c) => `- ${c.text}`).join("\n")
    : "- (no new comments; continue the task)";
  return context("Board sent the ticket back to Claude", `The ticket "${t.title}" was sent back to you.

# User feedback since last run
${feedback}

${t.mode === "interview" ? `${t.interviewed ? AFTER_ANSWERS : INTERVIEW.replace("In this first run:", "Before continuing, in this run:")}\n\n` : ""}Continue working on the ticket, addressing the feedback. If a pull request already exists, push new commits to the same branch to update it. Update deliverables in ${outputDir} rather than creating duplicates.

${targetDesignRule(outputDir)}${PEERS_RULE}

${artifactRule()}

${RESULT_RULE}`);
}

/** Ticket chats can file ckanban bugs on the user's request (report_bug tool or the CLI). */
export function bugReportRule(t: Ticket): string {
  return `If the user asks to report a bug in ckanban itself (this board app, not their project): draft a title and a markdown description (what happened, numbered steps to reproduce, expected vs actual), show it and wait for their yes, then file it with the ckanban \`report_bug\` tool (ticketId "${t.id}") or \`${helperCommand()} ticket report-bug ${t.id} --title "<title>" --body-file -\` (description on stdin), and reply with the issue URL or the fallback link it prints.`;
}

export type ChatMode = "refine" | "act";

/** A chat message sent while Claude is already working: it arrives at Claude's next step. */
export function steerPrompt(text: string): string {
  return `${text.trim()}

${context("", `(Sent from the kanban board's ticket chat while you were working. Take it into account and carry on; keep following the instructions you were given for this run, including how to end it.)`)}`;
}

/** The daemon restarted while Claude was replying: pick the reply up where it was cut off. */
export function interruptedPrompt(): string {
  return context("Reply interrupted by daemon restart; Claude continues", `The board restarted while you were replying, so your last reply was cut off and the user never saw its end. Continue from where you stopped: finish what you were doing and give the user your full reply. Keep following the instructions you were given earlier in this conversation (same mode, same rules, same way to end).`);
}

/** A message the user typed in the ticket's chat. Their text comes first; board instructions are wrapped so the UI can hide them. */
export function chatPrompt(t: Ticket, text: string, mode: ChatMode, outputDir: string): string {
  const typed = text.trim();
  if (mode === "refine") {
    const start = typed ? "" : `The user just moved this ticket to Planning and is waiting for you in the ticket chat. Start now:
- If important things are unclear, briefly say what you understood so far and interview them.
- If the ticket is already clear enough to work on autonomously, skip the questions: propose the polished ticket, or say it looks ready.

`;
    return `${typed}${typed ? "\n\n" : ""}${context(typed ? "" : "Board asked Claude to help refine this ticket", `${start}(Sent from the kanban board's ticket chat. The user reads your reply there, not in a terminal.)
You are helping the user shape this ticket BEFORE any work starts. Do not modify files or start the work (mockups go in reply blocks, see below); reading code, docs and links to understand the context is fine.

Current ticket
Title: ${t.title}
Description:
${t.body.trim() || "(empty)"}

How to help:
- Interview the user about what is still unclear: goal and why, who it is for, scope (must-haves vs nice-to-haves), constraints, how we know it's done. Ask only what matters for this ticket, in small rounds.
- When you know enough (or the user asks), propose the improved ticket. After the user applies it they will move it to Ready and Claude will work on it autonomously, so make it self-contained.
- Otherwise reply naturally and briefly, like in a normal chat.
${bugReportRule(t)}

${mockupsRule(outputDir)}

${PLANNING_ARTIFACT_RULE}

${QUESTIONS_FORMAT}

${TICKET_FORMAT}

${TICKETS_FORMAT}

${BRANCH_FORMAT}`)}`;
  }
  return `${typed}

${context("", `(Sent from the kanban board's ticket chat for "${t.title}". The user reads your reply there, not in a terminal.)
Act on the message as you would in an interactive session. If a pull request already exists, push new commits to the same branch. Save research/writing deliverables in ${outputDir}.
If the message only asks you to plan, audit, review, list ideas, propose or discuss, and no changes are wanted yet (e.g. "don't change anything yet"): do not modify any files, answer, and end your reply with <ckanban-move to="planning"/> on its own line. The board then moves the ticket to Planning, where the next steps get shaped before any work.
If you need decisions from the user, ask with the ask_questions tool.
${bugReportRule(t)}

If the message asks for new or follow-up tickets from this ticket: do not modify any files or start that work. Write each description from what you know here (files, decisions, what shipped), so the new ticket's Claude needs no other context. ${TICKETS_FORMAT}
${BRANCH_FORMAT}
If proposing tickets or a branch was all the message asked for, put <ckanban-stay/> on its own line before the result line: the card then stays in its column.

${targetDesignRule(outputDir)}${QUESTIONS_FORMAT}

${artifactRule()}

${RESULT_RULE}`)}`;
}

export function planningPrompt(t: Ticket, ticketFile: string): string {
  return `We are PLANNING a kanban ticket together. Do NOT implement anything yet.

# Ticket: ${t.title}

${t.body.trim() || "(no description)"}

Discuss the task with me, explore the code if useful, and ask clarifying questions. When we agree on the plan, rewrite the body of the ticket file below with the refined plan (keep the YAML frontmatter between the --- lines exactly as it is; only replace the text after it):
${ticketFile}`;
}

export function resumeCommand(dir: string, sessionId: string): string {
  return `cd ${shellQuote(dir)} && claude --resume ${sessionId}`;
}

export function planningCommand(dir: string, sessionId: string, prompt: string, exists: boolean): string {
  const flag = exists ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  return `cd ${shellQuote(dir)} && claude ${flag} ${shellQuote(prompt)}`;
}

export type PlanWake = "event" | "final";

/**
 * Wakes a planner ticket's session while its plan runs: either child events to decide on, or the
 * final check once every child is done. The first line is what the ticket chat shows.
 */
export function orchestratorPrompt(t: Ticket, o: { kind: PlanWake; events: string[]; table: string; board: string; outputDir: string }): string {
  const head = o.kind === "final"
    ? "Plan finished: every child ticket is done. Run the final check and write the summary."
    : `Plan update: ${o.events.length} child ticket${o.events.length === 1 ? " needs" : "s need"} a decision.\n${o.events.map((e) => `- ${e}`).join("\n")}`;
  const job = o.kind === "final"
    ? `# Final check
1. \`git fetch\`, then run the project's full checks (tests, typecheck, build, as its CLAUDE.md / README says) on the latest remote base branch, in a fresh temporary worktree (\`git worktree add --detach <tmp dir> origin/<base branch>\`; remove it afterwards), never in a folder with someone's uncommitted work.
2. If something is broken, fix it if it is small and safe, following the repo's instructions for landing changes; otherwise add a follow-up child ticket with create_ticket and say so.
3. Write ${o.outputDir}/plan-summary.md: TL;DR, what shipped per child (commit SHAs or PR links), what was skipped and why, follow-ups.
4. End with status "done" (or "blocked" if a human must step in).`
    : `# What to do
Decide each event and act with the ckanban MCP tools, then end the run; the board keeps the plan going.
- Child failed or blocked: read it with get_ticket, add a hint with comment_ticket (the child reads new comments on its next run), fix its description with update_ticket if it was unclear, then move_ticket it to "ready" to retry (at most ${MAX_RETRIES} retries per child). Or split it: create_ticket new children (they land in Backlog and start when their dependsOn are done) and move the old one to "done" with a comment saying why. Or skip it: comment why and move it to "done".
- Child is asking questions: answer them yourself with chat_ticket when the plan and code give you the answer; only ask the user when it is a business decision you can't make.
- Child finished with an open PR: review it (\`gh pr view\`, \`gh pr diff\`, its checks). If it is good, merge it with \`gh pr merge --squash\` (the board moves the child to Done once merged). If not, comment what to change and move it to "ready".
- Don't do a child's work yourself in this session; keep this reply short.`;
  return `${head}

${context("Plan update from the board", `You are the planner (orchestrator) of ticket "${t.title}" (${t.id}) on board ${o.board}. The board runs this ticket's child tickets unattended, in dependency order, a few at a time, and wakes you only when a decision is needed. The user is not watching.

# Child tickets
${o.table}

${job}

# Your board rights
The ckanban MCP tools create_ticket, update_ticket (title, body, status, mode, dependsOn), move_ticket, chat_ticket, stop_ticket and comment_ticket work on THIS plan's child tickets only; everything else on the board is refused. create_ticket here always makes a child of this plan in Backlog (auto mode). Every change is logged on the child.

# When you need the user
End with status "blocked" (or "questions" after asking with the ask_questions tool) only when a human must decide or fix something. That pauses the plan and notifies the user. Otherwise end with "done".

${RESULT_RULE}`)}`;
}
