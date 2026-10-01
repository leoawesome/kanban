// `ckanban mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) exposing the board as tools.
// Hand-rolled instead of @modelcontextprotocol/sdk: we only need initialize, tools/list and tools/call.
import {
  assertCanChange, BoardClient, ClientError, parseMode, parseStatus, profileList, resolveProfile, runProfile,
  ticketLine, ticketText, type TicketPatch,
} from "./client";
import { STATUSES } from "./server/types";
import { VERSION } from "./server/version";

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
const MODE = {
  type: "string",
  enum: ["interview", "auto"],
  description: "interview: Claude asks the user clarifying questions before working. auto: Claude just does it.",
};

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Changes the board: refused inside board runs. */
  changes: boolean;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  client: Pick<BoardClient,
    "listProfiles" | "listTickets" | "getTicket" | "createTicket" | "updateTicket" | "deleteTicket" | "chat" | "stop" | "listComments" | "comment">;
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
      },
      required: ["title"],
    },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.createTicket(slug, {
        title: str(args, "title")!.trim(),
        body: typeof args?.body === "string" ? args.body : "",
        status: args?.status ? parseStatus(args.status) : "backlog",
        mode: args?.mode ? parseMode(args.mode) : "interview",
      });
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
      properties: { profile: PROFILE, id: ID, title: { type: "string" }, body: { type: "string", description: "New markdown description (replaces the old one)." }, status: STATUS, mode: MODE },
      required: ["id"],
    },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch: TicketPatch = {};
      if (typeof args?.title === "string" && args.title.trim()) patch.title = args.title.trim();
      if (typeof args?.body === "string") patch.body = args.body;
      if (args?.status) patch.status = parseStatus(args.status);
      if (args?.mode) patch.mode = parseMode(args.mode);
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass title, body, status or mode");
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, patch);
      return `Updated ${t.id}: ${ticketLine(t)}`;
    },
  },
  {
    name: "move_ticket",
    description: "Move a ticket to another column. ready starts a Claude run; planning starts the interview in the board chat.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, status: STATUS }, required: ["id", "status"] },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, { status: parseStatus(str(args, "status")) });
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
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.chat(slug, str(args, "id")!, str(args, "message")!);
      return `Sent to ${t.id}. ${t.running ? "Claude is working on it" : `Ticket is in ${t.status}`}; read the reply later with get_ticket or on the board.`;
    },
  },
  {
    name: "stop_ticket",
    description: "Stop the Claude run working on a ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const r = await ctx.client.stop(slug, id);
      return r.stopped ? `Stopped the run on ${id}.` : `${id} had no run to stop.`;
    },
  },
  {
    name: "comment_ticket",
    description: "Add a comment to a ticket. Claude reads new comments at the start of its next run.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, text: { type: "string" } }, required: ["id", "text"] },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.comment(slug, id, str(args, "text")!);
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
    if (tool.changes) assertCanChange(ctx.env);
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
          "find what to do next, or check on, start or steer tickets. Tickets you create land in Backlog in interview mode by default.",
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
