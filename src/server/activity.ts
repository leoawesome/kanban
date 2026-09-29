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

export function summarizeEvent(ev: any): string | null {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "result") return "Finished";
  if (ev.type !== "assistant") return null;
  const blocks = contentBlocks(ev);
  const tool = blocks.findLast((b) => b.type === "tool_use");
  if (tool) {
    const input = tool.input ?? {};
    const key = ARG_KEYS.find((k) => typeof input[k] === "string");
    return key ? `${tool.name}: ${shortArg(key, input[key])}` : String(tool.name);
  }
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
