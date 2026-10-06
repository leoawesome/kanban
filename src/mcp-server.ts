// `ckanban mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) exposing the board as tools.
// Hand-rolled instead of @modelcontextprotocol/sdk: we only need initialize, tools/list and tools/call.
import {
  assertCanChange, BoardClient, bugReportText, ClientError, parseMode, parseStatus, profileList, resolveProfile, RUN_ENV, runProfile,
  ticketLine, ticketText, type ScheduleHistoryInfo, type ScheduleInfo, type ScheduleInput, type TicketPatch,
} from "./client";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactJob, type ArtifactOutcome, runArtifactJob } from "./server/artifact";
import { STATUSES } from "./server/types";
import { REPO, VERSION } from "./server/version";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PROFILE = {
  type: "string",
  description: "Board (profile) slug. Omit to use the board whose folder contains the current working directory.",
};
const ID = { type: "string", description: "Ticket id, e.g. t_20261001_abcd (from list_tickets)." };
const STATUS = {
  type: "string",
  enum: STATUSES,
  description: "Column. backlog: idea, nothing runs. planning: Claude interviews the user in the board chat. " +
    "ready: queued, Claude starts working as soon as a slot is free. in_progress/review/done: usually set by the board.",
};
const SCHEDULE_ID = { type: "string", description: "Schedule id (from list_schedules)." };
const CRON = {
  type: "string",
  description: "5-field cron (minute hour day-of-month month day-of-week) in this computer's local time. " +
    "Examples: \"0 9 * * 1-5\" weekdays 09:00, \"0 3 * * *\" daily 03:00, \"0 9 * * 1\" Mondays 09:00, \"*/30 * * * *\" every 30 minutes, \"0 * * * *\" hourly.",
};
const SCHEDULE_FIELDS = {
  name: { type: "string", description: "Short name shown in the Schedules list, e.g. \"Nightly dependency audit\"." },
  title: { type: "string", description: "Title of each ticket it creates. {date} and {time} are filled in, e.g. \"Dependency audit {date}\"." },
  body: {
    type: "string",
    description: "The prompt each ticket gets, in markdown. It runs unattended with no access to this conversation, " +
      "so make it self-contained: goal, context (files, commands), steps, what done looks like.",
  },
  cron: CRON,
  mode: {
    type: "string", enum: ["auto", "interview"],
    description: "auto: Claude just does it (right for unattended runs). interview: each ticket waits for the user's answers first. Default: auto.",
  },
  enabled: { type: "boolean", description: "false pauses the schedule (no runs, no catch-up when resumed). Default: true." },
  skipIfRunning: { type: "boolean", description: "Skip a run while the previous ticket from this schedule is still queued or running. Default: true." },
};

const DEPENDS_ON = {
  type: "array", items: { type: "string" },
  description: "Sibling child tickets (ticket id or key) that must be done before a running plan starts this one. Replaces the list.",
};

function depList(args: any): string[] | undefined {
  if (args?.dependsOn === undefined) return undefined;
  if (!Array.isArray(args.dependsOn)) throw new ClientError("dependsOn must be a list of ticket ids or keys");
  return args.dependsOn.filter((d: unknown) => typeof d === "string" && d.trim()).map((d: string) => d.trim());
}

const NEEDS = {
  type: "array", items: { type: "string" },
  description:
    "Exclusive resources this ticket's runs use, e.g. [\"emulator\"]: tickets that need the same one never run at the same time " +
    "(on any board), in any order. Use it for a shared device instead of chaining dependsOn. Replaces the list; [] clears it.",
};

function needsList(args: any): string[] | undefined {
  if (args?.needs === undefined) return undefined;
  if (!Array.isArray(args.needs) || args.needs.some((n: unknown) => typeof n !== "string")) throw new ClientError("needs must be a list of resource names, e.g. [\"emulator\"]");
  return args.needs.map((n: string) => n.trim().toLowerCase()).filter(Boolean);
}

/** The ticket a board run belongs to ("<profile>/<ticket id>" in CKANBAN_TICKET), or null outside runs. */
function runTicketId(ctx: ToolContext): string | null {
  return ctx.env[RUN_ENV]?.split("/")[1] || null;
}

const MODE = {
  type: "string",
  enum: ["interview", "auto"],
  description: "interview: Claude asks the user clarifying questions before working. auto: Claude just does it.",
};

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** MCP tool hints; readOnlyHint lets Claude Code call it in plan mode (the planning chat). */
  annotations?: { readOnlyHint?: boolean };
  /** Changes the board: refused inside board runs, unless allowInRun. */
  changes: boolean;
  /**
   * Schedule edits only affect future fire times (the user can pause them), so board runs may make them,
   * including a scheduled run refining its own schedule. Every edit is credited to the run's ticket in the history.
   */
  allowInRun?: boolean;
  /** Inside a board run the daemon decides: only a running plan's planner may use it, on its own child tickets. */
  plannerScope?: boolean;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  client: Pick<BoardClient,
    | "listProfiles" | "listTickets" | "getTicket" | "createTicket" | "updateTicket" | "deleteTicket" | "chat" | "stop" | "listComments"
    | "comment" | "ask" | "pollQuestion" | "replyQuestion" | "reportBug" | "listSchedules" | "createSchedule" | "updateSchedule" | "deleteSchedule" | "runSchedule"
    | "scheduleHistory" | "cronPreview" | "adopt" | "planAction">;
  cwd: string;
  env: Record<string, string | undefined>;
  main?: (dir: string) => string | null;
  /** Waits between ask_ticket polls (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Runs an artifact publish/read (tests pass a fake). Default: runArtifactJob. */
  artifact?: (job: ArtifactJob, timeoutMs: number) => Promise<ArtifactOutcome>;
}

/** How long ask_ticket waits for the reply: 10 minutes, or less when Claude Code's MCP_TOOL_TIMEOUT would cut the call off sooner. */
export function askWaitMs(env: Record<string, string | undefined>): number {
  const wait = 10 * 60_000;
  const limit = Number(env.MCP_TOOL_TIMEOUT);
  // Claude Code ignores values under 1s; leave 15s for the last poll and the answer to get back.
  if (!Number.isFinite(limit) || limit < 1000) return wait;
  return Math.max(1000, Math.min(wait, limit - 15_000));
}

const ASK_POLL_MS = 1000;

/** How long an artifact job may take: 3 minutes, or less when MCP_TOOL_TIMEOUT would cut the call off sooner. */
export function artifactWaitMs(env: Record<string, string | undefined>): number {
  const wait = 180_000;
  const limit = Number(env.MCP_TOOL_TIMEOUT);
  if (!Number.isFinite(limit) || limit < 1000) return wait;
  return Math.max(1000, Math.min(wait, limit - 5_000));
}

/** File name for a published page: the artifact id when updating (so updates overwrite it), else the title. */
export function artifactFileName(url: string | undefined, title: string | undefined, now: number): string {
  const id = url?.match(/\/artifact\/([A-Za-z0-9-]+)/)?.[1];
  const slug = (id ?? title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || `artifact-${now}`}.html`;
}

function runArtifact(job: ArtifactJob, ctx: ToolContext): Promise<ArtifactOutcome> {
  const timeoutMs = artifactWaitMs(ctx.env);
  if (ctx.artifact) return ctx.artifact(job, timeoutMs);
  return runArtifactJob(job, { bin: ctx.env.CKANBAN_CLAUDE_BIN, model: ctx.env.CKANBAN_ARTIFACT_MODEL, timeoutMs });
}

const ARTIFACT_URL = { type: "string", description: "claude.ai artifact link, e.g. https://claude.ai/artifact/AbC123." };

// The board's stand-in for the Artifact tool, which headless runs don't get. readOnlyHint lets the planning
// chat (plan mode) use them: publishing only writes the page to the ticket's outputs folder, never the project.
const ARTIFACT_TOOLS: Tool[] = [
  {
    name: "read_artifact",
    description:
      "Read a claude.ai artifact and return its page source (HTML). Use it to look at an artifact, or before publish_artifact " +
      "with its url to update it: edit the returned HTML and publish the whole page. Takes a minute or two.",
    inputSchema: { type: "object", properties: { url: ARTIFACT_URL }, required: ["url"] },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const url = str(args, "url")!.trim();
      const r = await runArtifact({ kind: "read", url }, ctx);
      if (!r.ok) throw new ClientError(`artifact read failed: ${r.error}`);
      if (r.kind !== "read") throw new ClientError("artifact read failed: no page source");
      return r.html;
    },
  },
  {
    name: "publish_artifact",
    description:
      "Publish a complete HTML page as a claude.ai artifact and return its link. Pass url to update that artifact " +
      "(same link, new version): read_artifact it first and send the full edited page, not a diff. " +
      "The page is also saved in the ticket's outputs folder. Takes a minute or two.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The full page source (a complete HTML document)." },
        url: { ...ARTIFACT_URL, description: "Artifact to update (keeps its link). Omit to publish a new page." },
        title: { type: "string", description: "Page title (optional)." },
      },
      required: ["html"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const html = str(args, "html")!;
      const url = str(args, "url", false)?.trim();
      const title = str(args, "title", false)?.trim();
      const dir = join(ctx.env.CKANBAN_OUTPUT_DIR || join(tmpdir(), "ckanban-artifacts"), "artifacts");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, artifactFileName(url, title, (ctx.now ?? Date.now)()));
      writeFileSync(file, html);
      const r = await runArtifact({ kind: "publish", file, url, title }, ctx);
      if (!r.ok) throw new ClientError(`artifact publish failed: ${r.error}`);
      if (r.kind !== "publish") throw new ClientError("artifact publish failed: no link came back");
      // Same wording as the Artifact tool, so the board lists the page on the ticket.
      return r.text;
    },
  },
];

async function slugFor(args: any, ctx: ToolContext): Promise<string> {
  const explicit = typeof args?.profile === "string" && args.profile.trim() ? args.profile : runProfile(ctx.env);
  return resolveProfile(await ctx.client.listProfiles(), { explicit, cwd: ctx.cwd, main: ctx.main }).slug;
}

function str(args: any, key: string, required = true): string | undefined {
  const v = args?.[key];
  if (typeof v === "string" && v.trim()) return v;
  if (required) throw new ClientError(`${key} is required`);
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO time as local "2026-10-01 09:00" (schedules run in this computer's local time). */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function scheduleLine(s: ScheduleInfo): string {
  const state = [s.enabled ? "active" : "paused"];
  if (s.active) state.push("running");
  const bits = [`${s.id}  [${state.join(", ")}]  ${s.name}: ${s.summary} (${s.cron})`];
  if (s.enabled && s.nextRunAt) bits.push(`next ${localTime(s.nextRunAt)}`);
  if (s.lastFiredAt) bits.push(`last ticket ${localTime(s.lastFiredAt)}`);
  if (s.lastError) bits.push(`last run failed to start: ${s.lastError}`);
  return bits.join("; ");
}

function scheduleText(s: ScheduleInfo): string {
  return [
    scheduleLine(s),
    `ticket title: ${s.title}`,
    `mode: ${s.mode}, skip while previous runs: ${s.skipIfRunning ? "yes" : "no"}`,
    "", s.body.trim() || "(no prompt)",
  ].join("\n");
}

function historyLine(e: ScheduleHistoryInfo): string {
  const t = e.ticket ? `${e.ticket.id} "${e.ticket.title}" [${e.ticket.running ? "running" : [e.ticket.status, e.ticket.outcome].filter(Boolean).join(", ")}]` : null;
  const at = localTime(e.at);
  if (e.kind === "fired") return `${at}  fired (${e.trigger}): ${t ?? `${e.ticketId} (deleted)`}`;
  if (e.kind === "skipped") return `${at}  skipped (${e.trigger}): previous ticket ${e.ticketId ?? ""} still queued or running`;
  if (e.kind === "error") return `${at}  could not create the ticket (${e.trigger}): ${e.message}`;
  const by = !e.by || e.by === "user" ? "the user" : `ticket ${e.by.ticketId}`;
  const fields = e.fields?.length ? ` ${e.fields.join(", ")}` : "";
  const prev = e.previous ? Object.entries(e.previous).map(([k, v]) => `\n    previous ${k}: ${String(v).replace(/\s+/g, " ").slice(0, 300)}`).join("") : "";
  return `${at}  ${e.action}${fields} by ${by}${prev}`;
}

function scheduleInput(args: any, partial: boolean): ScheduleInput {
  const out: ScheduleInput = {};
  for (const k of ["name", "title", "body", "cron"] as const) {
    if (typeof args?.[k] === "string") out[k] = args[k];
    else if (!partial && k !== "body") throw new ClientError(`${k} is required`);
  }
  if (args?.mode !== undefined) out.mode = parseMode(args.mode);
  for (const k of ["enabled", "skipIfRunning"] as const) {
    if (args?.[k] === undefined) continue;
    if (typeof args[k] !== "boolean") throw new ClientError(`${k} must be true or false`);
    out[k] = args[k];
  }
  return out;
}

const SCHEDULE_TOOLS: Tool[] = [
  {
    name: "list_schedules",
    description:
      "List a board's schedules (recurring tickets): id, active/paused, when it fires (plain English + cron), next run, last ticket, errors. " +
      "Check this before create_schedule to avoid duplicates.",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const ss = await ctx.client.listSchedules(slug);
      return ss.length ? `Schedules on board ${slug}:\n${ss.map(scheduleLine).join("\n")}` : `Board ${slug} has no schedules.`;
    },
  },
  {
    name: "create_schedule",
    description:
      "Create a schedule: at each cron time the board creates a ticket from it and Claude starts working on it right away, unattended. " +
      "Use it when the user wants something done regularly (nightly audit, weekly changelog, daily CI check). " +
      "Runs happen only while the ckanban daemon is running; one missed run is caught up when it starts. " +
      "Returns the schedule id and its next run times.",
    inputSchema: { type: "object", properties: { profile: PROFILE, ...SCHEDULE_FIELDS }, required: ["name", "title", "body", "cron"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const s = await ctx.client.createSchedule(slug, scheduleInput(args, false), ctx.env[RUN_ENV]);
      const p = await ctx.client.cronPreview(s.cron).catch(() => null);
      const next = p?.next.length ? `\nNext runs: ${p.next.map(localTime).join(", ")}` : "";
      return `Created schedule ${s.id} on board ${slug}: ${s.name}, ${s.summary} (${s.cron}), ${s.mode} mode.${next}\n` +
        "The user can see, pause or edit it in the board's Schedules dialog.";
    },
  },
  {
    name: "update_schedule",
    description:
      "Change a schedule: any of name, title, prompt (body), cron, mode, skipIfRunning; enabled false/true pauses/resumes it. " +
      "Only the fields you pass change. A run created by a schedule may update its own schedule (e.g. refine its prompt); " +
      "the old prompt is kept in the schedule's history.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID, ...SCHEDULE_FIELDS }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch = scheduleInput(args, true);
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass name, title, body, cron, mode, enabled or skipIfRunning");
      const s = await ctx.client.updateSchedule(slug, str(args, "id")!, patch, ctx.env[RUN_ENV]);
      return `Updated: ${scheduleLine(s)}`;
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule (tickets it already created stay). Only when the user asked; to stop it for a while, pause it with update_schedule enabled=false.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.deleteSchedule(slug, id, ctx.env[RUN_ENV]);
      return `Deleted schedule ${id}.`;
    },
  },
  {
    name: "run_schedule",
    description: "Fire a schedule now: creates its ticket and starts it, without moving the next scheduled run. Not available inside board runs.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID }, required: ["id"] },
    // Starts a run immediately, so like create_ticket it stays off-limits to board runs.
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const { entry } = await ctx.client.runSchedule(slug, str(args, "id")!);
      if (entry.kind === "fired") return `Started: created ticket ${entry.ticketId}, Claude is working on it.`;
      if (entry.kind === "skipped") return `Skipped: the previous ticket ${entry.ticketId ?? ""} from this schedule is still queued or running.`;
      throw new ClientError(`could not create the ticket: ${entry.message}`);
    },
  },
  {
    name: "schedule_history",
    description: "Show a schedule's settings and history, newest first: tickets it created with their status, skips, errors, and edits (who changed what, with the previous prompt).",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, id: SCHEDULE_ID, limit: { type: "number", description: "Entries to show. Default: 20." } },
      required: ["id"],
    },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const [all, h] = await Promise.all([ctx.client.listSchedules(slug), ctx.client.scheduleHistory(slug, id)]);
      const s = all.find((x) => x.id === id);
      const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
      const lines = h.slice(0, limit).map(historyLine);
      return `${s ? scheduleText(s) : `Schedule ${id}`}\n\nHistory:\n${lines.length ? lines.join("\n") : "(not run yet)"}`;
    },
  },
];

// --- Planning chat cards ----------------------------------------------------------------------
// The board's planning chat renders these calls (from the session transcript) as a form or cards.
// The tools only check the input, so a bad call comes back to Claude as an error to fix.

const MAX_TITLE = 80;
const SHOWN = "Shown to the user as a card. End your turn and wait for their reply.";

const isText = (v: unknown): v is string => typeof v === "string" && !!v.trim();

function titleError(title: unknown, where: string): string | null {
  if (!isText(title)) return `${where}title is required`;
  if (title.trim().length >= MAX_TITLE) return `${where}title must be under ${MAX_TITLE} characters (it has ${title.trim().length})`;
  return null;
}

/** Checks ask_questions input; returns what's wrong, or null when it's fine. */
export function questionsError(args: any): string | null {
  const qs = args?.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 5) return "questions must be a list of 1-5 questions";
  for (const [i, q] of qs.entries()) {
    const at = `question ${i + 1}: `;
    if (!isText(q?.question)) return `${at}question text is required`;
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) return `${at}give 2-4 options`;
    if (opts.some((o: any) => !isText(o?.label))) return `${at}every option needs a label`;
    const rec = opts.filter((o: any) => o?.recommended === true).length;
    if (rec !== 1) return `${at}mark exactly one option recommended (found ${rec})`;
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return `${at}multiSelect must be true or false`;
  }
  return null;
}

/** Checks propose_ticket input; returns what's wrong, or null when it's fine. */
export function proposalError(args: any): string | null {
  return titleError(args?.title, "") ?? (isText(args?.description) ? null : "description is required");
}

/** Checks propose_tickets input; returns what's wrong, or null when it's fine. */
export function ticketsError(args: any): string | null {
  const ts = args?.tickets;
  if (!Array.isArray(ts) || !ts.length) return "tickets must be a non-empty list";
  const keys = new Set<string>();
  for (const [i, t] of ts.entries()) {
    const at = `ticket ${i + 1}: `;
    if (!isText(t?.key)) return `${at}key is required`;
    if (keys.has(t.key.trim())) return `${at}key "${t.key.trim()}" is used twice; keys must be unique`;
    keys.add(t.key.trim());
    const e = titleError(t.title, at) ?? (isText(t.description) ? null : `${at}description is required`);
    if (e) return e;
  }
  for (const [i, t] of ts.entries()) {
    if (t.dependsOn === undefined) continue;
    if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d: unknown) => typeof d !== "string")) return `ticket ${i + 1}: dependsOn must be a list of keys`;
    const bad = t.dependsOn.find((d: string) => !keys.has(d.trim()) || d.trim() === t.key.trim());
    if (bad !== undefined) return `ticket ${i + 1}: dependsOn "${bad}" is not the key of another ticket in this list (keys: ${[...keys].join(", ")})`;
  }
  for (const [i, t] of ts.entries()) {
    if (t.needs === undefined) continue;
    if (!Array.isArray(t.needs) || t.needs.some((n: unknown) => typeof n !== "string")) return `ticket ${i + 1}: needs must be a list of resource names, e.g. ["emulator"]`;
  }
  return null;
}

const TITLE = { type: "string", description: "Short, specific title (under 80 characters)." };

const PLANNING_TOOLS: Tool[] = [
  {
    name: "ask_questions",
    description:
      "Board planning chat only: ask the user questions as a form in the board's ticket chat (they can also add free text). " +
      "Their answers come back as the user's next message. At most 5 questions per round, 2-4 options each, exactly one option recommended; " +
      "multiSelect true only when several options can apply. Put a one-line intro in your reply; don't repeat the questions as text. " +
      "Nothing is created or changed. After the call, end your turn and wait for the answers.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array", minItems: 1, maxItems: 5,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              options: {
                type: "array", minItems: 2, maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string", description: "Short note on what this option means." },
                    recommended: { type: "boolean", description: "true on exactly one option." },
                    mockup: { type: "string", description: "File name of the mockup this option stands for (e.g. a-two-buttons.html); the form links to its preview." },
                  },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean", description: "Several options can apply. Default: false." },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = questionsError(args);
      if (e) throw new ClientError(`${e}. Fix it and call ask_questions again.`);
      return SHOWN.replace("a card", "a form");
    },
  },
  {
    name: "propose_ticket",
    description:
      "Board planning chat only: propose an improved title and markdown description for this ticket. " +
      "The board shows it as a card; the user clicks Apply to replace the ticket's title and description. " +
      "Write the description self-contained (## Goal, ## Context, ## Scope, ## Requirements, ## Acceptance criteria, ## Open questions): " +
      "Claude works on it later without this chat. Nothing is created or changed by the call.",
    inputSchema: {
      type: "object",
      properties: { title: TITLE, description: { type: "string", description: "Markdown description." } },
      required: ["title", "description"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = proposalError(args);
      if (e) throw new ClientError(`${e}. Fix it and call propose_ticket again.`);
      return SHOWN;
    },
  },
  {
    name: "propose_branch",
    description:
      "Board ticket chat (any column): offer to branch this ticket, like Claude Code's /branch. Use it when the user asks to branch, fork, " +
      "or try another direction in parallel without losing this one. The board shows a card with a Branch button; the user's click creates " +
      "\"Branch: <title>\" in Planning with a copy of this conversation and its own git branch off this ticket's branch (committed work only). " +
      "Nothing is created by the call; don't start the other direction yourself.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One short line: what the branch is for (e.g. try SQLite instead of Postgres)." } },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      if (args?.reason !== undefined && typeof args.reason !== "string") throw new ClientError("reason must be a string. Fix it and call propose_branch again.");
      return SHOWN;
    },
  },
  {
    name: "propose_tickets",
    description:
      "Board ticket chat (any column): propose new tickets, e.g. splitting the work or follow-ups, linked to this ticket as their parent. Call list_tickets first to avoid duplicates. " +
      "The board shows one card per ticket; the user clicks Create to add it to Backlog, linked to this ticket. " +
      "Each description must be self-contained (goal, context with relevant files, acceptance criteria). " +
      "key is a short unique name; dependsOn lists keys that must be finished first: give one to tickets that build on each other or likely edit the same files. " +
      "needs lists exclusive resources (e.g. [\"emulator\"]): tickets that need the same one never run at the same time, in any order. " +
      "Nothing is created by the call.",
    inputSchema: {
      type: "object",
      properties: {
        tickets: {
          type: "array", minItems: 1,
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Short unique name, e.g. api." },
              title: TITLE,
              description: { type: "string", description: "Markdown description." },
              dependsOn: { type: "array", items: { type: "string" }, description: "Keys of tickets in this list that must be finished first." },
              needs: { type: "array", items: { type: "string" }, description: "Exclusive resources its runs use, e.g. [\"emulator\"]." },
            },
            required: ["key", "title", "description"],
          },
        },
      },
      required: ["tickets"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = ticketsError(args);
      if (e) throw new ClientError(`${e}. Fix it and call propose_tickets again.`);
      return SHOWN;
    },
  },
];

export const TOOLS: Tool[] = [
  {
    name: "list_profiles",
    description: "List the kanban boards (profiles) and the repo folder each one belongs to.",
    inputSchema: { type: "object", properties: {} },
    changes: false,
    async run(_args, ctx) {
      const ps = await ctx.client.listProfiles();
      return profileList(ps);
    },
  },
  {
    name: "list_tickets",
    description: "List tickets on a board with id, column and title. Call this before create_ticket to avoid duplicates.",
    inputSchema: { type: "object", properties: { profile: PROFILE, status: { ...STATUS, description: "Only this column." } } },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      let ts = await ctx.client.listTickets(slug);
      if (args?.status) {
        const s = parseStatus(args.status);
        ts = ts.filter((t) => t.status === s);
      }
      return ts.length ? `Board ${slug}:\n${ts.map(ticketLine).join("\n")}` : `Board ${slug}: no tickets${args?.status ? ` in ${args.status}` : ""}.`;
    },
  },
  {
    name: "get_ticket",
    description: "Show one ticket: description, column, run state, branch/PR and comments.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const [t, comments] = await Promise.all([ctx.client.getTicket(slug, id), ctx.client.listComments(slug, id)]);
      return ticketText(t, comments);
    },
  },
  {
    name: "create_ticket",
    description:
      "Create a ticket on the board. Check list_tickets first so you don't add a duplicate. " +
      "Write a self-contained description in markdown (## Goal, ## Context with relevant files, ## Acceptance criteria), " +
      "because another Claude session will work on it later without this conversation. " +
      "Leave status and mode at their defaults (backlog, interview) unless the user explicitly asks to start work or skip the interview.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        title: { type: "string", description: "Short, specific title (under 80 characters)." },
        body: { type: "string", description: "Markdown description." },
        status: { ...STATUS, description: `${STATUS.description} Default: backlog.` },
        mode: { ...MODE, description: `${MODE.description} Default: interview.` },
        key: { type: "string", description: "Planner only: short name siblings can use in dependsOn." },
        dependsOn: DEPENDS_ON,
        needs: NEEDS,
      },
      required: ["title"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const deps = depList(args);
      const needs = needsList(args);
      const t = await ctx.client.createTicket(slug, {
        title: str(args, "title")!.trim(),
        body: typeof args?.body === "string" ? args.body : "",
        status: args?.status ? parseStatus(args.status) : "backlog",
        mode: args?.mode ? parseMode(args.mode) : "interview",
        ...(str(args, "key", false) ? { planKey: str(args, "key")!.trim() } : {}),
        ...(deps ? { dependsOn: deps } : {}),
        ...(needs?.length ? { needs } : {}),
      }, ctx.env[RUN_ENV]);
      return `Created ${t.id} on board ${slug} in ${t.status} (${t.mode} mode): ${t.title}`;
    },
  },
  {
    name: "update_ticket",
    description:
      "Edit a ticket's title, description, column, mode, dependsOn or needs. Moving it to ready starts a Claude run, " +
      "moving it to planning starts the interview in the board chat (same as dragging it on the board). " +
      "A planner can take one of its children out of its plan with release: true.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE, id: ID, title: { type: "string" }, body: { type: "string", description: "New markdown description (replaces the old one)." },
        status: STATUS, mode: MODE, dependsOn: DEPENDS_ON, needs: NEEDS,
        release: { type: "boolean", description: "true: take the ticket out of its plan (it keeps its column; its dependsOn and key are cleared)." },
      },
      required: ["id"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch: TicketPatch = {};
      if (typeof args?.title === "string" && args.title.trim()) patch.title = args.title.trim();
      if (typeof args?.body === "string") patch.body = args.body;
      if (args?.status) patch.status = parseStatus(args.status);
      if (args?.mode) patch.mode = parseMode(args.mode);
      const deps = depList(args);
      if (deps) patch.dependsOn = deps;
      const needs = needsList(args);
      if (needs) patch.needs = needs;
      if (args?.release === true) patch.parentId = null;
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass title, body, status, mode, dependsOn, needs or release");
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, patch, ctx.env[RUN_ENV]);
      return `Updated ${t.id}: ${ticketLine(t)}`;
    },
  },
  {
    name: "move_ticket",
    description: "Move a ticket to another column. ready starts a Claude run; planning starts the interview in the board chat.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, status: STATUS }, required: ["id", "status"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, { status: parseStatus(str(args, "status")) }, ctx.env[RUN_ENV]);
      return `Moved ${t.id} to ${t.status}${t.running ? " (Claude is working on it)" : ""}.`;
    },
  },
  {
    name: "adopt_tickets",
    description:
      "Manager mode: make existing tickets on this board children of this ticket, so its plan runs them (use when the user asks you, in this " +
      "ticket's chat, to manage, run or take over tickets). Find them with list_tickets first. Tickets in another plan, finished ones, this " +
      "ticket and its parents are skipped with a reason. Adopted tickets keep their column, mode, dependsOn and needs; nothing starts until " +
      "the plan starts (plan_control). Then set dependsOn (ticket ids) and needs with update_ticket. Tell the user what was adopted and skipped. " +
      "Inside a board run it only works in a reply to the user's own message in this ticket's chat.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        ids: { type: "array", items: { type: "string" }, description: "Ticket ids to adopt, e.g. [\"t_20261001_abcd\"]." },
        id: { ...ID, description: "Adopting ticket. Default: the ticket of this board run." },
      },
      required: ["ids"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false) ?? runTicketId(ctx);
      if (!id) throw new ClientError("id is required outside a board run");
      if (!Array.isArray(args?.ids) || !args.ids.some((x: unknown) => typeof x === "string" && x.trim())) throw new ClientError("ids must be a non-empty list of ticket ids");
      const r = await ctx.client.adopt(slug, id, args.ids.filter((x: unknown) => typeof x === "string"), ctx.env[RUN_ENV]);
      const lines = [
        r.adopted.length ? `Adopted ${r.adopted.length}:\n${r.adopted.map((t) => `- ${ticketLine(t)}`).join("\n")}` : "Adopted none.",
        ...(r.skipped.length ? [`Skipped ${r.skipped.length}:\n${r.skipped.map((x) => `- ${x.id}: ${x.reason}`).join("\n")}`] : []),
        "Nothing starts until the plan starts: set dependsOn / needs with update_ticket, then call plan_control.",
      ];
      return lines.join("\n\n");
    },
  },
  {
    name: "plan_control",
    description:
      "Start or resume this ticket's plan, so the board runs its child tickets unattended: in dependency order, a few at a time, one ticket per " +
      "exclusive resource (needs) at a time, never a child waiting on the user. Use it when the user asked you to run, manage or take over the " +
      "tickets. Pausing, finishing and how many run at once stay with the user (Plan tab). Inside a board run it works for the ticket's own plan " +
      "only: in a reply to the user's message in this ticket's chat, or while the plan runs.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        action: { type: "string", enum: ["start", "resume"], description: "start a new plan, or resume a paused or stuck one (both work either way)." },
        id: { ...ID, description: "Planner ticket. Default: the ticket of this board run." },
      },
      required: ["action"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false) ?? runTicketId(ctx);
      if (!id) throw new ClientError("id is required outside a board run");
      const action = args?.action === "resume" ? "resume" : args?.action === "start" ? "start" : null;
      if (!action) throw new ClientError("action must be start or resume");
      const t = await ctx.client.planAction(slug, id, action, ctx.env[RUN_ENV]);
      const p = t.plan;
      return `Plan of ${t.id} is ${p?.state ?? "not started"}${p ? ` (${p.maxConcurrent} at a time)` : ""}. ` +
        "The board starts children itself and wakes this ticket when one needs a decision; end your reply now.";
    },
  },
  {
    name: "chat_ticket",
    description:
      "Send a message to the Claude session working on a ticket (or start one), like typing in the board's ticket chat. " +
      "Answering a question form or applying a proposed ticket can only be done in the board UI.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, message: { type: "string" } }, required: ["id", "message"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.chat(slug, str(args, "id")!, str(args, "message")!, ctx.env[RUN_ENV]);
      return `Sent to ${t.id}. ${t.running ? "Claude is working on it" : `Ticket is in ${t.status}`}; read the reply later with get_ticket or on the board.`;
    },
  },
  {
    name: "ask_ticket",
    description:
      "Ask the Claude session of another ticket on this board a question and wait for its reply (up to about 10 minutes). " +
      "Use it when you need something only that ticket's Claude knows (what it changed and why, an API it is building); " +
      "read the ticket with get_ticket first. The question goes into that ticket's real session: it steers its run if Claude is working, " +
      "or starts a short reply there; both tickets' chats show the exchange. The reply may be a clarifying question: then call ask_ticket again with more detail. " +
      "If no reply comes in time it arrives later as a message in your run (or a comment for your next run). Only works inside a board run.",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, id: { ...ID, description: "Ticket whose Claude to ask (same board), e.g. t_20261001_abcd." }, question: { type: "string", description: "Short, self-contained question." } },
      required: ["id", "question"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const run = ctx.env[RUN_ENV];
      if (!run) throw new ClientError("ask_ticket only works inside a board run: it asks on behalf of that run's ticket");
      const slug = await slugFor(args, ctx);
      const now = ctx.now ?? Date.now;
      const sleep = ctx.sleep ?? Bun.sleep;
      const waitMs = askWaitMs(ctx.env);
      const q = await ctx.client.ask(slug, str(args, "id")!, str(args, "question")!, waitMs, run);
      const who = `ticket ${q.to} "${q.toTitle}"`;
      const deadline = now() + waitMs;
      for (;;) {
        const final = now() >= deadline;
        // A daemon restart mid-wait is not the end: keep polling until the deadline.
        const r = await ctx.client.pollQuestion(slug, q.id, final, run).catch(() => ({ reply: null }));
        if (r.reply !== null) return `Reply from ${who}:\n\n${r.reply}`;
        if (final) {
          return `No reply yet from ${who} (question ${q.id}); it will arrive later as a message in your run, ` +
            "or as a comment for your next run. Carry on with other work meanwhile.";
        }
        await sleep(Math.max(0, Math.min(ASK_POLL_MS, deadline - now())));
      }
    },
  },
  {
    name: "reply_ticket",
    description:
      "Reply to a question another ticket's Claude asked you with ask_ticket (the message names the question id). " +
      "Answer it, or ask a clarifying question back; then carry on with your own work.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        questionId: { type: "string", description: "Question id from the message, e.g. q_ab12cd34." },
        text: { type: "string", description: "Your reply." },
      },
      required: ["questionId", "text"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const r = await ctx.client.replyQuestion(slug, str(args, "questionId")!, str(args, "text")!, ctx.env[RUN_ENV]);
      const how = r.delivered === "call" ? "it got it right away"
        : r.delivered === "steer" ? "it had stopped waiting, so it arrives as a message in its run"
        : r.delivered === "comment" ? "it had stopped waiting, so it was left as a comment for its next run"
        : "that ticket no longer exists";
      return `Sent your reply to ticket ${r.from}; ${how}.`;
    },
  },
  {
    name: "stop_ticket",
    description: "Stop the Claude run working on a ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const r = await ctx.client.stop(slug, id, ctx.env[RUN_ENV]);
      return r.stopped ? `Stopped the run on ${id}.` : `${id} had no run to stop.`;
    },
  },
  {
    name: "comment_ticket",
    description: "Add a comment to a ticket. Claude reads new comments at the start of its next run.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, text: { type: "string" } }, required: ["id", "text"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.comment(slug, id, str(args, "text")!, ctx.env[RUN_ENV]);
      return `Commented on ${id}.`;
    },
  },
  {
    name: "delete_ticket",
    description: "Delete a ticket and its worktree. Only do this when the user asked for it.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.deleteTicket(slug, id);
      return `Deleted ${id}.`;
    },
  },
  {
    name: "report_bug",
    description:
      `File a bug in ckanban itself as a GitHub issue on ${REPO}. ` +
      "Only use it when the user asks to report a ckanban bug, never on your own initiative. " +
      "Before calling, show the user the title and description you will send and wait for a yes. " +
      "Write the description in markdown with: what happened, steps to reproduce (numbered), expected vs actual. " +
      "Pass ticketId to attach that ticket's details, last run result and log tail (home and data paths and secrets are hidden). " +
      "Screenshots can't be uploaded: tell the user to drag them into a comment on the issue. " +
      "Returns the issue URL, or a prefilled link to finish it in the browser when gh is missing or logged out.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short summary of the bug (under 80 characters)." },
        description: { type: "string", description: "Markdown: what happened, steps to reproduce, expected vs actual." },
        ticketId: { ...ID, description: "Ticket the bug showed up on (optional): its context is attached." },
        includeLogs: { type: "boolean", description: "Attach the tail of the ticket's last run log. Default: true." },
        profile: PROFILE,
      },
      required: ["title", "description"],
    },
    // Doesn't change the board, so it works from a board run's ticket chat too.
    changes: false,
    async run(args, ctx) {
      const ticketId = str(args, "ticketId", false);
      const slug = ticketId ? await slugFor(args, ctx) : undefined;
      const include: ("env" | "ticket" | "log")[] = ["env", "ticket"];
      if (args?.includeLogs !== false) include.push("log");
      const r = await ctx.client.reportBug({
        title: str(args, "title")!.trim(), description: str(args, "description")!, profile: slug, ticketId, include, source: "ai",
      });
      return bugReportText(r);
    },
  },
  ...PLANNING_TOOLS,
  ...ARTIFACT_TOOLS,
  ...SCHEDULE_TOOLS,
];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
  if (!tool) return text(`unknown tool ${name}`, true);
  try {
    if (tool.changes && !tool.allowInRun && !tool.plannerScope) assertCanChange(ctx.env);
    return text(await tool.run(args ?? {}, ctx));
  } catch (e) {
    return text((e as Error).message, true);
  }
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(msg: JsonRpc, ctx: ToolContext): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  const isRequest = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "ckanban", version: VERSION },
        instructions:
          "Tools for the user's local ckanban board. Use them when the user asks to put work on the board, " +
          "find what to do next, or check on, start or steer tickets. Tickets you create land in Backlog in interview mode by default. " +
          "Schedules (create_schedule etc.) make the board create and run a ticket on a cron, for work the user wants done regularly. " +
          "ask_questions, propose_ticket, propose_tickets and propose_branch are for the board's ticket chats: they show a form or cards to the user. " +
          "read_artifact and publish_artifact read, update and publish claude.ai artifacts where the Artifact tool isn't available.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case "tools/call":
      return reply(await callTool(String(msg.params?.name ?? ""), msg.params?.arguments, ctx));
    default:
      return isRequest ? fail(-32601, `method not found: ${msg.method}`) : null;
  }
}

export async function serveStdio(ctx: ToolContext = { client: new BoardClient(), cwd: process.cwd(), env: process.env }): Promise<void> {
  const write = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  const decoder = new TextDecoder();
  let buf = "";
  const pending: Promise<void>[] = [];
  const handle = (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      pending.push(handleMessage(m, ctx).then((r) => {
        if (r) write(r);
      }, (e) => {
        if (m?.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
      }));
    }
  };
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  await Promise.all(pending);
}
