/** The part of a tool call these helpers read (kept free of api.ts so server tests can import them). */
type ToolCall = { name: string; input: Record<string, unknown> };

/** What the Input section shows (and Copy copies): the tool's main argument, or all of its input as JSON. */
export function mainInput(d: ToolCall): string {
  const str = (k: string) => (typeof d.input[k] === "string" && d.input[k] ? (d.input[k] as string) : null);
  switch (d.name) {
    case "Bash": return str("command") ?? json(d.input);
    case "Read": case "Edit": case "MultiEdit": case "Write": case "NotebookEdit":
      return str("file_path") ?? str("notebook_path") ?? json(d.input);
    case "WebFetch": return str("url") ?? json(d.input);
    case "WebSearch": return str("query") ?? json(d.input);
  }
  return json(d.input);
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

export type DiffLine = { kind: "rm" | "ad" | "gap"; text: string };

/** Same cap as tool output: a huge Write shouldn't freeze the chat. */
export const DIFF_MAX = 8000;

/** Edit / MultiEdit / Write as removed and added lines; null for other tools. */
export function editDiff(d: ToolCall): { lines: DiffLine[]; truncated: boolean } | null {
  const pairs: { old: string; new: string }[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (d.name === "Edit") pairs.push({ old: s(d.input.old_string), new: s(d.input.new_string) });
  else if (d.name === "MultiEdit" && Array.isArray(d.input.edits)) for (const e of d.input.edits as any[]) pairs.push({ old: s(e?.old_string), new: s(e?.new_string) });
  else if (d.name === "Write") pairs.push({ old: "", new: s(d.input.content) });
  else return null;
  const lines: DiffLine[] = [];
  let size = 0;
  for (const [i, p] of pairs.entries()) {
    if (i) lines.push({ kind: "gap", text: "⋯" });
    for (const [kind, text] of [["rm", p.old], ["ad", p.new]] as const) {
      if (!text) continue;
      for (const line of text.split("\n")) {
        if (size > DIFF_MAX) return { lines, truncated: true };
        size += line.length + 1;
        lines.push({ kind, text: line });
      }
    }
  }
  return { lines, truncated: false };
}
