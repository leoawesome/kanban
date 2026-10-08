import { readFileSync } from "node:fs";

/** One tool call in full, for the chat's expanded tool rows. */
export interface ToolDetail {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The tool_result text; null while the call has no result yet (or the session lost it). */
  output: string | null;
  isError: boolean;
  /** The output was longer than TOOL_OUTPUT_MAX and was cut. */
  truncated: boolean;
}

/** Same cap as the terminal transcript view. */
export const TOOL_OUTPUT_MAX = 8000;

/** Finds a tool call and its result in a session (or subagent) transcript; null when the id isn't there. */
export function findToolDetail(raw: string, toolUseId: string): ToolDetail | null {
  let detail: ToolDetail | null = null;
  const needle = JSON.stringify(toolUseId);
  for (const line of raw.split("\n")) {
    // Cheap skip: only lines mentioning the id can hold its call or result.
    if (!line.includes(needle)) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b.id === toolUseId) {
        const input = b.input && typeof b.input === "object" ? b.input : {};
        detail = { id: toolUseId, name: String(b.name ?? "tool"), input, output: null, isError: false, truncated: false };
      } else if (b?.type === "tool_result" && b.tool_use_id === toolUseId && detail) {
        const text = resultText(b.content);
        detail.isError = b.is_error === true;
        detail.truncated = text.length > TOOL_OUTPUT_MAX;
        detail.output = detail.truncated ? text.slice(0, TOOL_OUTPUT_MAX) : text;
      }
    }
  }
  return detail;
}

/** Looks through files in order (the session, then its subagents' transcripts). */
export function findToolDetailIn(files: string[], toolUseId: string): ToolDetail | null {
  const needle = JSON.stringify(toolUseId);
  for (const f of files) {
    let raw = "";
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!raw.includes(needle)) continue;
    const d = findToolDetail(raw, toolUseId);
    if (d) return d;
  }
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : ""))
    .join("\n");
}
