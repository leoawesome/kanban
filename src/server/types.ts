export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";
export type Outcome = null | "done" | "blocked" | "failed" | "stopped" | "needs_input";
/** interview: Claude asks clarifying questions before doing the work. auto: just do it. */
export type TicketMode = "interview" | "auto";

export const STATUSES: Status[] = ["backlog", "planning", "ready", "in_progress", "review", "done"];

export interface Profile {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  maxParallel: number;
  model?: string | null;
  createdAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  /** Missing on tickets created before modes existed: treated as "auto". */
  mode?: TicketMode;
  /** True once Claude has asked the user a round of questions on this ticket. */
  interviewed?: boolean;
  /** True once any claude run used this ticket's sessionId (so later runs must --resume). */
  sessionStarted?: boolean;
  /** True once a refine conversation began (auto-start on entering Planning happens only once). */
  refineStarted?: boolean;
  order: number;
  sessionId: string | null;
  worktree: string | null;
  /** Folder of a linked pre-existing Claude session (runs happen here instead of a worktree). */
  workdir?: string | null;
  branch: string | null;
  prUrl: string | null;
  outcome: Outcome;
  lastActivity: string | null;
  lastRunAt: string | null;
  runCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface Comment {
  id: string;
  author: "user" | "ai";
  text: string;
  at: string;
}

export interface Config {
  port: number;
  prPollMinutes: number;
}

export interface OutputFile {
  name: string;
  size: number;
  updatedAt: string;
}

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}
