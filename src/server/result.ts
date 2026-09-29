export interface RunResult {
  status: "done" | "blocked";
  prUrl: string | null;
  summary: string;
}

const PREFIX = "CKANBAN_RESULT:";

export function parseResult(text: string): RunResult | null {
  const lines = text.split("\n").filter((l) => l.includes(PREFIX));
  const line = lines.at(-1);
  if (!line) return null;
  const json = line.slice(line.indexOf(PREFIX) + PREFIX.length).trim().replace(/`+$/, "").trim();
  try {
    const v = JSON.parse(json);
    if (v.status !== "done" && v.status !== "blocked") return null;
    return {
      status: v.status,
      prUrl: typeof v.prUrl === "string" && v.prUrl ? v.prUrl : null,
      summary: typeof v.summary === "string" ? v.summary : "",
    };
  } catch {
    return null;
  }
}
