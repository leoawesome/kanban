import type { Comment, Ticket } from "./types";
import { shellQuote } from "./util";

const RESULT_RULE = `When you are finished, end your final message with exactly one line in this format (valid JSON, single line):
CKANBAN_RESULT: {"status":"done"|"blocked","prUrl":<string or null>,"summary":"<1-3 sentence summary for the user>"}
Use "blocked" if you could not complete the task and need the user (explain why in summary).`;

export function firstRunPrompt(t: Ticket, isGit: boolean, linked = false, comments: Comment[] = []): string {
  const intro = linked
    ? `This conversation is now linked to a kanban ticket and continues unattended. Use everything above as context and carry the ticket forward.`
    : `You are an autonomous agent working a kanban ticket. No human is watching; do not ask questions, make reasonable decisions.`;
  const where = linked
    ? `You are working in the main checkout of this project (not an isolated worktree). If you change code, create or reuse a feature branch; never commit directly to the default branch.`
    : isGit
    ? `You are working in a dedicated git worktree on branch for this ticket.`
    : `You are working in a folder that is NOT a git repository.`;
  return `${intro}

# Ticket: ${t.title}

${t.body.trim() || "(no description)"}
${comments.length ? `\n# User notes\n${comments.map((c) => `- ${c.text}`).join("\n")}\n` : ""}
# Rules
- ${where}
- Decide whether this task requires changing files in a code project.
- If it changes files and this is a git repo with a GitHub remote: commit your changes, push the branch, open a pull request with \`gh pr create\`, and include the PR URL in the result line.
- If it is a development task but git or a GitHub remote is not available, do NOT fake it. Stop, and report status "blocked" explaining what is missing.
- If it is a non-code task (research, writing, analysis, file organisation), just do it and report the result. No PR needed.

${RESULT_RULE}`;
}

export function resumePrompt(t: Ticket, newComments: Comment[]): string {
  const feedback = newComments.length
    ? newComments.map((c) => `- ${c.text}`).join("\n")
    : "- (no new comments; continue the task)";
  return `The ticket "${t.title}" was sent back to you.

# User feedback since last run
${feedback}

Continue working on the ticket, addressing the feedback. If a pull request already exists, push new commits to the same branch to update it.

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
