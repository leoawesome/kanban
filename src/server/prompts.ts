import { helperCommand } from "./artifact";
import type { Comment, Ticket } from "./types";
import { shellQuote } from "./util";

const RESULT_RULE = `When you finish this run, end your final message with exactly one line in this format (valid JSON, single line):
CKANBAN_RESULT: {"status":"done"|"blocked"|"questions","prUrl":<string or null>,"summary":"<1-3 sentence summary for the user>"}
- "questions": you are waiting for the user's answers (the questions must be in your final message).
- "blocked": you cannot continue without something from the user (explain what in summary).
- "done": the task is complete.`;

/** How Claude asks questions so the board can render them as a clickable form. */
export const QUESTIONS_FORMAT = `To ask the user questions, put them in ONE block like this in your message (valid JSON array):
<ckanban-questions>
[{"question":"Who will read the result?","options":[{"label":"My manager","description":"decision-oriented, 1 page","recommended":true},{"label":"Engineering team","description":"technical depth"}],"multiSelect":false}]
</ckanban-questions>
The board shows it as a form (the user can also add free text) and sends the answers back as the user's next message. Rules: at most 5 questions per round, 2-4 options each, mark exactly one option "recommended", set "multiSelect": true only when several options can apply. Put a one-line intro before the block; don't repeat the questions as plain text.`;

/** How Claude proposes an improved ticket so the board can show an Apply button. */
export const TICKET_FORMAT = `To propose an improved ticket, add ONE block like this (valid JSON; description is markdown):
<ckanban-ticket>{"title":"Short, specific title (under 80 characters)","description":"## Goal\\n...\\n\\n## Context\\n...\\n\\n## Scope\\n**In:** ...\\n**Out:** ...\\n\\n## Requirements\\n- ...\\n\\n## Acceptance criteria\\n- ...\\n\\n## Open questions\\n- ..."}</ckanban-ticket>
The board shows it as a card; the user clicks Apply to replace the ticket's title and description.`;

/** How a planner ticket's chat proposes splitting the work into new tickets; the user creates them by clicking. */
export const TICKETS_FORMAT = `When the user wants to split the work into separate tickets (this ticket as the planner), first call the ckanban \`list_tickets\` tool to avoid duplicates, then add ONE block like this (valid JSON array; description is markdown):
<ckanban-tickets>[{"title":"Short, specific title (under 80 characters)","description":"## Goal\\n...\\n\\n## Context\\n...\\n\\n## Acceptance criteria\\n- ..."}]</ckanban-tickets>
Each description must be self-contained (goal, context with relevant files, acceptance criteria): another Claude session works on it later without this chat. The board shows one card per ticket; the user clicks Create to add it to Backlog, linked to this ticket. You cannot create tickets yourself here.`;

function context(note: string, body: string): string {
  return `<ckanban-context note="${note.replace(/"/g, "'")}">\n${body}\n</ckanban-context>`;
}

const INTERVIEW = `# How to work: interview first
The user wants to be interviewed before you do the work. In this first run:
1. Gather just enough context to ask good questions: read the ticket, its links, relevant code, docs and notes. Do NOT produce the deliverable yet.
2. Find what is unclear and would change the result: the goal (why is this wanted, who asked), the audience, the deliverable and its format, what "good" looks like (criteria), scope and depth, constraints, deadline.
3. Ask your questions using the questions block below.
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
- ${where}
- Decide whether this task requires changing files in a code project.
- If it changes files and this is a git repo with a GitHub remote: commit your changes, push the branch, open a pull request with \`gh pr create\`, and include the PR URL in the result line.
- If it is a development task but git or a GitHub remote is not available, do NOT fake it. Stop, and report status "blocked" explaining what is missing.
- If it is a non-code task (research, writing, analysis, file organisation), no PR is needed.

${deliverableRule(ctx.outputDir)}

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

${artifactRule()}

${RESULT_RULE}`);
}

/** Ticket chats can file Claude Kanban bugs on the user's request (report_bug tool or the CLI). */
export function bugReportRule(t: Ticket): string {
  return `If the user asks to report a bug in Claude Kanban itself (this board app, not their project): draft a title and a markdown description (what happened, numbered steps to reproduce, expected vs actual), show it and wait for their yes, then file it with the ckanban \`report_bug\` tool (ticketId "${t.id}") or \`${helperCommand()} ticket report-bug ${t.id} --title "<title>" --body-file -\` (description on stdin), and reply with the issue URL or the fallback link it prints.`;
}

export type ChatMode = "refine" | "act";

/** A chat message sent while Claude is already working: it arrives at Claude's next step. */
export function steerPrompt(text: string): string {
  return `${text.trim()}

${context("", `(Sent from the kanban board's ticket chat while you were working. Take it into account and carry on; keep following the instructions you were given for this run, including how to end it.)`)}`;
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
You are helping the user shape this ticket BEFORE any work starts. Do not modify files or start the work; reading code, docs and links to understand the context is fine.

Current ticket
Title: ${t.title}
Description:
${t.body.trim() || "(empty)"}

How to help:
- Interview the user about what is still unclear: goal and why, who it is for, scope (must-haves vs nice-to-haves), constraints, how we know it's done. Ask only what matters for this ticket, in small rounds.
- When you know enough (or the user asks), propose the improved ticket. After the user applies it they will move it to Ready and Claude will work on it autonomously, so make it self-contained.
- Otherwise reply naturally and briefly, like in a normal chat.
${bugReportRule(t)}

${QUESTIONS_FORMAT}

${TICKET_FORMAT}

${TICKETS_FORMAT}`)}`;
  }
  return `${typed}

${context("", `(Sent from the kanban board's ticket chat for "${t.title}". The user reads your reply there, not in a terminal.)
Act on the message as you would in an interactive session. If a pull request already exists, push new commits to the same branch. Save research/writing deliverables in ${outputDir}.
If the message only asks you to plan, audit, review, list ideas, propose or discuss, and no changes are wanted yet (e.g. "don't change anything yet"): do not modify any files, answer, and end your reply with <ckanban-move to="planning"/> on its own line. The board then moves the ticket to Planning, where the next steps get shaped before any work.
If you need decisions from the user, ask with the questions block.
${bugReportRule(t)}

${QUESTIONS_FORMAT}

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
