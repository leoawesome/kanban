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

/** A tool Claude left running in the background (a long Bash call, a subagent). */
export interface BackgroundTask {
  id: string;
  description: string;
  /** When the board first saw it. */
  startedAt: string;
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
  /** When the current run or chat reply started; null when Claude is not working. Missing on old tickets. */
  runStartedAt?: string | null;
  /** Claude ended its turn and waits for these background tasks; it resumes when they finish. */
  waitingOn?: BackgroundTask[] | null;
  runCount: number;
  error: string | null;
  /** Non-fatal heads-up about how the ticket runs (e.g. no worktree yet); the user can dismiss it. */
  notice?: string | null;
  /** Set on tickets created by a schedule (see Schedule). */
  scheduleId?: string | null;
  /** Planner ticket whose Planning chat proposed this one. Missing on most tickets. */
  parentId?: string | null;
  /** Short name siblings use in dependsOn (from the planner's proposal). */
  planKey?: string | null;
  /** Siblings (ticket id or planKey) that must be done before a running plan starts this ticket. */
  dependsOn?: string[];
  /** Ticket this one was branched from (a copy of its conversation and committed code). Not a plan parent. */
  branchedFrom?: string | null;
  /** When the branch was made: conversation entries before this are the copied history. */
  branchPoint?: BranchPoint | null;
  /** Set on a planner ticket once its plan was started: the board runs its children unattended. */
  plan?: Plan | null;
  /** Chat messages sent while Claude was working that it has not read yet, oldest first. */
  queued?: QueuedMessage[];
  /** A chat reply the daemon cut off by restarting (or held back while a restart waited); recover() resumes it. */
  interrupted?: Interrupted | null;
  /** Output files the user published as claude.ai pages from the Outputs tab, one link per file. */
  shareLinks?: ShareLink[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface ShareLink {
  /** Path relative to the outputs folder. */
  file: string;
  url: string;
  at: string;
}

export interface BranchPoint {
  at: string;
  /** Source title at branch time (shown if the source is deleted later). */
  sourceTitle: string;
}

/** Recurring ticket template: on each cron tick the board creates a ticket from it and runs it. */
export interface Schedule {
  id: string;
  name: string;
  /** Ticket title; `{date}` and `{time}` are filled in when it fires. */
  title: string;
  /** Ticket description (the prompt). */
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  /** Skip a fire while the previous ticket from this schedule is still queued or running. */
  skipIfRunning: boolean;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  /** Null while paused. */
  nextRunAt: string | null;
  /** Why the last fire could not create its ticket (cleared by the next successful fire). */
  lastError: string | null;
}

export type ScheduleTrigger = "schedule" | "missed" | "manual";

/** Who changed a schedule: the user (board UI, CLI, Claude outside a run) or the board run of a ticket. */
export type ScheduleEditor = "user" | { ticketId: string };

export type ScheduleEditAction = "created" | "updated" | "paused" | "resumed";

/** Fields whose old value an "updated" entry keeps, so a bad edit (e.g. a run rewriting its own prompt) can be undone. */
export type SchedulePrevious = Partial<Pick<Schedule, "title" | "body" | "cron">>;

export type ScheduleHistoryEntry =
  | { at: string; kind: "fired"; trigger: ScheduleTrigger; ticketId: string }
  | { at: string; kind: "skipped"; trigger: ScheduleTrigger; ticketId: string | null }
  | { at: string; kind: "error"; trigger: ScheduleTrigger; message: string }
  | { at: string; kind: "edited"; action: ScheduleEditAction; fields: string[]; by: ScheduleEditor; previous?: SchedulePrevious };

export interface Interrupted {
  at: string;
  mode: "refine" | "act";
  /** A reply to another ticket's Claude: the card stays as it was. */
  quiet?: boolean;
  /** What Claude had written of its reply when it was cut off (shown greyed until the resumed reply arrives). */
  partial?: string;
  /** Claude never got this prompt (cut off during setup, or held while a restart waited): send it again as is. */
  prompt?: { text: string; raw?: boolean };
  /** Held back while a restart waited, not cut off: resumed without the interruption note. */
  held?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  /** queued: Claude reads it at its next step. unsent: the run was stopped first; the user sends or discards it. */
  state: "queued" | "unsent";
  /**
   * From another ticket's Claude (ask_ticket / a late reply): sent as-is, without the ticket-chat note, and
   * a reply run it starts leaves the card, outcome and run count alone.
   */
  peer?: boolean;
}

/** A question one ticket's Claude asked another's (ask_ticket), kept per board in questions.json. */
export interface TicketQuestion {
  id: string;
  /** Asking ticket. */
  from: string;
  /** Ticket whose Claude is asked. */
  to: string;
  text: string;
  askedAt: string;
  /** The asker's ask_ticket call waits for the reply until then. */
  waitUntil: string;
  /** The asker's call is still waiting (false once it took the reply or gave up). */
  waiting: boolean;
  reply: string | null;
  repliedAt: string | null;
  /** How the reply reached the asker: its waiting call, a message into its run, or a comment for its next run. */
  delivered: null | "call" | "steer" | "comment";
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

export type PlanState = "running" | "paused" | "finishing" | "done" | "stuck";

/** A planner's unattended run of its child tickets (see plan.ts and Board.advancePlans). */
export interface Plan {
  state: PlanState;
  /** Children of this plan in Ready or In progress at once. */
  maxConcurrent: number;
  /** Times the planner's Claude session was woken up (capped, see plan.ts). */
  wakeups: number;
  startedAt: string;
  finishedAt?: string | null;
  /** Children when the plan started; the planner may add up to the same number again. */
  originalCount: number;
  /** Child events waiting for the planner's next wake-up, so several arrive as one message. */
  inbox?: string[];
  /** Last child state the planner was told about, per child id, so it is told once. */
  seen?: Record<string, string>;
  /** Planner restarts of a child that already ran, per child id (capped). */
  retries?: Record<string, number>;
  /** The planner was woken and its reply decides what happens next. */
  awaiting?: "event" | "final" | null;
  /** Why the plan is stuck. */
  reason?: string | null;
}
