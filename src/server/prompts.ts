import type { Comment, Ticket } from "./types";
import { shellQuote } from "./util";

const RESULT_RULE = `When you finish this run, end your final message with exactly one line in this format (valid JSON, single line):
CKANBAN_RESULT: {"status":"done"|"blocked"|"questions","prUrl":<string or null>,"summary":"<1-3 sentence summary for the user>"}
- "questions": you are waiting for the user's answers (the questions must be in your final message).
- "blocked": you cannot continue without something from the user (explain what in summary).
- "done": the task is complete.`;

const INTERVIEW = `# How to work: interview first
The user wants to be interviewed before you do the work. In this first run:
1. Gather just enough context to ask good questions: read the ticket, its links, relevant code, docs and notes. Do NOT produce the deliverable yet.
2. Find what is unclear and would change the result: the goal (why is this wanted, who asked), the audience, the deliverable and its format, what "good" looks like (criteria), scope and depth, constraints, deadline.
3. Ask at most 6 questions in your final message. Number them. Give each 2-4 lettered options with a short explanation, and mark the one you recommend with "(Recommended)". Example:
   1. Who is the audience?
      a) Your manager: decision-oriented, 1 page (Recommended)
      b) Engineering team: technical depth
4. Say that the user can reply briefly (e.g. "1a, 2c, 3: <free text>") or "go" to accept all recommendations.
5. End with status "questions".
Only skip the interview if the ticket already answers all of this; then write the brief (below) and do the task.`;

const AFTER_ANSWERS = `If you were interviewing the user and have not started the work yet:
- If the answers still leave gaps that would change the result, ask a short follow-up round (same format, status "questions").
- Otherwise start your reply with a "Brief" section (3-6 bullets: goal, audience, deliverable, criteria, scope), then do the task.
- "go", "just do it" or similar means: use your recommended options and proceed.`;

function deliverableRule(outputDir: string): string {
  return `# Deliverables
- Outputs folder for this ticket: ${outputDir}
- For research, analysis, planning or writing tasks, save the deliverable there as a well-structured Markdown file (for example report.md). Start with a short TL;DR and a clear recommendation, then the details. The user reads files in this folder from the board.
- Quantify when you can reach real data (code, logs, analytics, cost dashboards, docs). Say where each number comes from and label estimates as estimates.
- Judge options against explicit criteria (e.g. value, cost, effort, risk) and end with concrete next steps.
- If you also publish the deliverable somewhere (e.g. as an artifact or doc), include the link in your summary.
- Code changes still belong in the repository, not in the outputs folder.`;
}

export interface PromptContext {
  isGit: boolean;
  linked?: boolean;
  comments?: Comment[];
  outputDir: string;
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
  return `${intro}

# Ticket: ${t.title}

${t.body.trim() || "(no description)"}
${comments.length ? `\n# User notes\n${comments.map((c) => `- ${c.text}`).join("\n")}\n` : ""}
${interview ? `${INTERVIEW}\n\n` : ""}# Rules
- ${where}
- Decide whether this task requires changing files in a code project.
- If it changes files and this is a git repo with a GitHub remote: commit your changes, push the branch, open a pull request with \`gh pr create\`, and include the PR URL in the result line.
- If it is a development task but git or a GitHub remote is not available, do NOT fake it. Stop, and report status "blocked" explaining what is missing.
- If it is a non-code task (research, writing, analysis, file organisation), no PR is needed.

${deliverableRule(ctx.outputDir)}

${RESULT_RULE}`;
}

export function resumePrompt(t: Ticket, newComments: Comment[], outputDir: string): string {
  const feedback = newComments.length
    ? newComments.map((c) => `- ${c.text}`).join("\n")
    : "- (no new comments; continue the task)";
  return `The ticket "${t.title}" was sent back to you.

# User feedback since last run
${feedback}

${t.mode === "interview" ? `${t.interviewed ? AFTER_ANSWERS : INTERVIEW.replace("In this first run:", "Before continuing, in this run:")}\n\n` : ""}Continue working on the ticket, addressing the feedback. If a pull request already exists, push new commits to the same branch to update it. Update deliverables in ${outputDir} rather than creating duplicates.

${RESULT_RULE}`;
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
