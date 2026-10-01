// `ckanban mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) exposing the board as tools.
// Hand-rolled instead of @modelcontextprotocol/sdk: we only need initialize, tools/list and tools/call.
import {
  assertCanChange, BoardClient, bugReportText, ClientError, parseMode, parseStatus, profileList, resolveProfile, RUN_ENV, runProfile,
  ticketLine, ticketText, type ScheduleHistoryInfo, type ScheduleInfo, type ScheduleInput, type TicketPatch,
} from "./client";
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

const MODE = {
  type: "string",
  enum: ["interview", "auto"],
  description: "interview: Claude asks the user clarifying questions before working. auto: Claude just does it.",
};

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
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
    | "comment" | "reportBug" | "listSchedules" | "createSchedule" | "updateSchedule" | "deleteSchedule" | "runSchedule"
    | "scheduleHistory" | "cronPreview">;
  cwd: string;
  env: Record<string, string | undefined>;
  main?: (dir: string) => string | null;
}

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
      "Runs happen only while the Claude Kanban daemon is running; one missed run is caught up when it starts. " +
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
      },
      required: ["title"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const deps = depList(args);
      const t = await ctx.client.createTicket(slug, {
        title: str(args, "title")!.trim(),
        body: typeof args?.body === "string" ? args.body : "",
        status: args?.status ? parseStatus(args.status) : "backlog",
        mode: args?.mode ? parseMode(args.mode) : "interview",
        ...(str(args, "key", false) ? { planKey: str(args, "key")!.trim() } : {}),
        ...(deps ? { dependsOn: deps } : {}),
      }, ctx.env[RUN_ENV]);
      return `Created ${t.id} on board ${slug} in ${t.status} (${t.mode} mode): ${t.title}`;
    },
  },
  {
    name: "update_ticket",
    description:
      "Edit a ticket's title, description, column or mode. Moving it to ready starts a Claude run, " +
      "moving it to planning starts the interview in the board chat (same as dragging it on the board).",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE, id: ID, title: { type: "string" }, body: { type: "string", description: "New markdown description (replaces the old one)." },
        status: STATUS, mode: MODE, dependsOn: DEPENDS_ON,
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
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass title, body, status, mode or dependsOn");
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
      `File a bug in Claude Kanban (ckanban) itself as a GitHub issue on ${REPO}. ` +
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
          "Tools for the user's local Claude Kanban board. Use them when the user asks to put work on the board, " +
          "find what to do next, or check on, start or steer tickets. Tickets you create land in Backlog in interview mode by default. " +
          "Schedules (create_schedule etc.) make the board create and run a ticket on a cron, for work the user wants done regularly.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
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
