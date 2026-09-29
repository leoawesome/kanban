export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";
export type Outcome = null | "done" | "blocked" | "failed" | "stopped";

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

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}
