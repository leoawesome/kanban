/** Standard 5-field cron (`min hour dom month dow`), evaluated in the machine's local time. */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Field was `*` (or `*\/n`): matters for the day-of-month / day-of-week OR rule. */
  domAny: boolean;
  dowAny: boolean;
}

export class CronError extends Error {}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const FIELDS: { name: string; min: number; max: number; names?: string[]; namesFrom?: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  // 7 is accepted as Sunday too.
  { name: "day of week", min: 0, max: 7, names: DAYS, namesFrom: 0 },
];

function parseField(raw: string, f: (typeof FIELDS)[number]): { values: Set<number>; any: boolean } {
  const num = (s: string): number => {
    const i = f.names?.indexOf(s.toLowerCase()) ?? -1;
    if (i >= 0) return i + f.namesFrom!;
    if (!/^\d+$/.test(s)) throw new CronError(`invalid ${f.name} value "${s}"`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw new CronError(`${f.name} ${n} is out of range (${f.min}-${f.max})`);
    return n;
  };
  const values = new Set<number>();
  let any = false;
  for (const part of raw.split(",")) {
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined || !range) throw new CronError(`invalid ${f.name} "${part}"`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) throw new CronError(`invalid ${f.name} step "${stepRaw}"`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      [lo, hi] = [f.min, f.max];
      if (raw === part) any = true;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined) throw new CronError(`invalid ${f.name} range "${range}"`);
      [lo, hi] = [num(a), num(b)];
      if (lo > hi) throw new CronError(`${f.name} range "${range}" goes backwards`);
    } else {
      lo = num(range);
      // `5/15` means 5, 20, 35, 50 (from 5 to the end).
      hi = stepRaw !== undefined ? f.max : lo;
    }
    for (let n = lo; n <= hi; n += step) values.add(n);
  }
  return { values, any };
}

export function parseCron(expr: string): Cron {
  const src = MACROS[expr.trim().toLowerCase()] ?? expr;
  const parts = src.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  const cron: Cron = {
    minute: minute.values, hour: hour.values, dom: dom.values, month: month.values, dow: dow.values,
    domAny: dom.any, dowAny: dow.any,
  };
  if (!nextRun(cron, new Date())) throw new CronError("this schedule never fires");
  return cron;
}

/** Validation for user input: the error message, or null when the expression is fine. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    if (e instanceof CronError) return e.message;
    throw e;
  }
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  // Classic cron: when both day fields are restricted, either one matching is enough.
  if (!c.domAny && !c.dowAny) return dom || dow;
  return dom && dow;
}

/** First fire time strictly after `after` (to the minute), or null if none within ~5 years. */
export function nextRun(c: Cron, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/** The next `n` fire times after `after`. */
export function nextRuns(c: Cron, after: Date, n: number): Date[] {
  const out: Date[] = [];
  let cur: Date | null = after;
  while (out.length < n && (cur = nextRun(c, cur))) out.push(cur);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Plain-English summary for the common shapes; falls back to the expression itself. */
export function describeCron(expr: string): string {
  const src = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const [m, h, dom, mon, dow] = src.split(/\s+/);
  const isNum = (s: string) => /^\d+$/.test(s);
  const step = (s: string) => s.match(/^\*\/(\d+)$/)?.[1];
  const at = isNum(m) && isNum(h) ? `${pad(Number(h))}:${pad(Number(m))}` : null;
  const days = (s: string): string | null => {
    if (s === "1-5") return "Weekdays";
    if (s === "0,6" || s === "6,0") return "Weekends";
    if (!/^[0-7](,[0-7])*$/.test(s)) return null;
    return `Every ${s.split(",").map((d) => DAY_NAMES[Number(d) % 7]).join(", ")}`;
  };
  if (src === "* * * * *") return "Every minute";
  if (step(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return step(m) === "1" ? "Every minute" : `Every ${step(m)} minutes`;
  if (isNum(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return m === "0" ? "Every hour" : `Every hour at :${pad(Number(m))}`;
  if (isNum(m) && step(h) && dom === "*" && mon === "*" && dow === "*") return `Every ${step(h)} hours at :${pad(Number(m))}`;
  if (at && dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${at}`;
    const d = days(dow);
    if (d) return `${d} at ${at}`;
  }
  if (at && isNum(dom) && mon === "*" && dow === "*") return `Monthly on day ${dom} at ${at}`;
  return `Cron: ${src}`;
}
