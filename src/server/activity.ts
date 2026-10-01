const ARG_KEYS = ["file_path", "command", "pattern", "url", "description", "path", "query"];

function shortArg(key: string, v: string): string {
  let s = v.split("\n")[0];
  if (key === "file_path" || key === "path") s = s.split("/").filter(Boolean).slice(-2).join("/");
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

function contentBlocks(ev: any): any[] {
  const c = ev?.message?.content;
  return Array.isArray(c) ? c : [];
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const READERS = new Set(["cat", "sed", "head", "tail", "less", "bat", "wc", "nl"]);
const SEARCHERS = new Set(["grep", "rg", "ag"]);
const TEST_RE = /^(?:(?:bun|npm|pnpm|yarn)(?: run)? test|npx (?:jest|vitest)|jest|vitest|pytest|go test|cargo test)\b/;

/** First real command of a shell line: skips `cd x &&`, env assignments and leading sudo. */
function mainCommand(cmd: string): string[] {
  for (const part of cmd.split("\n")[0].split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^\w+=/.test(words[0]) || words[0] === "sudo")) words.shift();
    // Redirects and heredocs are not arguments.
    const end = words.findIndex((x) => /^\d?[<>]/.test(x));
    if (end >= 0) words.length = end;
    if (/^(?:bunx|npx|pnpx)$/.test(words[0] ?? "")) words.shift();
    if (words.length && words[0] !== "cd") return words;
  }
  return [];
}

function describeBash(cmd: string): string {
  const words = mainCommand(cmd);
  const line = words.join(" ");
  if (!words.length) return `Bash: ${clip(cmd.split("\n")[0])}`;
  if (TEST_RE.test(line)) return "Running tests";
  const [w] = words;
  const args = words.slice(1).filter((a) => !a.startsWith("-"));
  if (w === "git") {
    const sub = words.slice(1).find((a, i, all) => !a.startsWith("-") && !/^-[Cc]$/.test(all[i - 1] ?? ""));
    return sub ? `Git: ${clip(sub, 30)}` : "Running git";
  }
  if (READERS.has(w)) {
    // sed's first plain argument is its script; the file comes after it.
    const file = (w === "sed" ? args.slice(1) : args).findLast((a) => /[\w.]/.test(a) && !/^[\d<>]/.test(a));
    const verb = w === "sed" && words.some((a) => /^-i/.test(a)) ? "Editing" : "Reading";
    if (file) return `${verb} ${clip(base(file.replace(/^['"]|['"]$/g, "")))}`;
  }
  if (SEARCHERS.has(w) && args[0]) return `Searching for "${clip(args[0].replace(/^['"]|['"]$/g, ""), 40)}"`;
  return `Running ${clip(w.split("/").pop()!, 30)}`;
}

/** Plain-English line for a tool call ("Reading Card.tsx"); unknown tools keep the `Name: arg` form. */
export function describeTool(name: string, input: any): string {
  const str = (k: string) => (typeof input?.[k] === "string" && input[k] ? (input[k] as string) : null);
  const file = str("file_path") ?? str("notebook_path") ?? str("path");
  switch (name) {
    case "Read": if (file) return `Reading ${clip(base(file))}`; break;
    case "Edit": case "MultiEdit": case "NotebookEdit": if (file) return `Editing ${clip(base(file))}`; break;
    case "Write": if (file) return `Writing ${clip(base(file))}`; break;
    case "Grep": if (str("pattern")) return `Searching for "${clip(str("pattern")!, 40)}"`; break;
    case "Glob": if (str("pattern")) return `Finding ${clip(str("pattern")!)}`; break;
    case "Bash": if (str("command")) return describeBash(str("command")!); break;
    case "WebSearch": return "Searching the web";
    case "WebFetch": {
      const url = str("url");
      if (url) { try { return `Reading ${new URL(url).host}`; } catch {} }
      break;
    }
    case "Task": case "Agent": if (str("description")) return `Delegating: ${clip(str("description")!)}`; break;
    case "TodoWrite": return "Updating the plan";
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1].replace(/_/g, " ")}: ${mcp[2].replace(/_/g, " ")}`;
  return rawTool(name, input);
}

function rawTool(name: string, input: any): string {
  const key = ARG_KEYS.find((k) => typeof input?.[k] === "string");
  return key ? `${name}: ${shortArg(key, input[key])}` : String(name);
}

/** One line for the card; `raw` keeps the exact tool call (`Bash: sed -n …`) for logs. */
export function summarizeEvent(ev: any, opts: { raw?: boolean } = {}): string | null {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "result") return "Finished";
  if (ev.type !== "assistant") return null;
  const blocks = contentBlocks(ev);
  const tool = blocks.findLast((b) => b.type === "tool_use");
  if (tool) return (opts.raw ? rawTool : describeTool)(String(tool.name), tool.input ?? {});
  const text = blocks.findLast((b) => b.type === "text" && b.text?.trim());
  if (text) return text.text.trim().replace(/\s+/g, " ").slice(0, 80);
  return null;
}

export function extractFinalText(events: any[]): string {
  const result = events.findLast((e) => e?.type === "result" && typeof e.result === "string");
  if (result) return result.result;
  for (let i = events.length - 1; i >= 0; i--) {
    const text = contentBlocks(events[i]).findLast((b) => b.type === "text" && b.text);
    if (events[i]?.type === "assistant" && text) return text.text;
  }
  return "";
}
