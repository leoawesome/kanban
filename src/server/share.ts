import { basename } from "node:path";

/**
 * Sharing a ticket's output files from the Outputs tab: reveal in Finder, put the file itself on the
 * clipboard (paste into Slack attaches it), download headers, and the page a markdown file is published as.
 * Paths are resolved by the caller (store.outputPath) and passed as argv, never through a shell.
 */

export class ShareError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Whether the file clipboard works here (osascript is macOS only). */
export const canCopyFile = (platform = process.platform) => platform === "darwin";

/** Select the file in Finder (`open -R`); other systems open its folder. */
export function revealArgv(file: string, bin?: string, platform = process.platform): string[] {
  if (bin) return [bin, "-R", file];
  if (platform === "darwin") return ["open", "-R", file];
  return ["xdg-open", file.slice(0, file.lastIndexOf("/")) || "/"];
}

/**
 * Writes the file's URL to the pasteboard the way Finder's Copy does (AppleScript's `set the clipboard to POSIX file`
 * doesn't stick). The path reaches the script as an argument, so it is never part of the script source.
 */
const COPY_FILE_JXA = `function run(argv) {
  ObjC.import("AppKit");
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  if (!pb.writeObjects($([$.NSURL.fileURLWithPath(argv[0])]))) throw new Error("the clipboard refused the file");
}`;

export function copyFileArgv(file: string, bin = "osascript"): string[] {
  return [bin, "-l", "JavaScript", "-e", COPY_FILE_JXA, file];
}

async function exec(argv: string[], what: string): Promise<void> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (e) {
    throw new ShareError(500, `couldn't run ${argv[0]}: ${(e as Error).message}`);
  }
  const err = await new Response(p.stderr as ReadableStream).text();
  if ((await p.exited) !== 0) throw new ShareError(500, `${what} failed: ${err.trim() || `${argv[0]} exited with an error`}`);
}

export function revealFile(file: string, bin = process.env.CKANBAN_OPEN_BIN): Promise<void> {
  return exec(revealArgv(file, bin), "Show in Finder");
}

/** CKANBAN_OSASCRIPT_BIN replaces osascript in tests. */
export function copyFileToClipboard(file: string, bin = process.env.CKANBAN_OSASCRIPT_BIN): Promise<void> {
  if (!bin && !canCopyFile()) throw new ShareError(501, "copying a file to the clipboard only works on macOS; use Download instead");
  return exec(copyFileArgv(file, bin), "Copy file");
}

/** Content-Disposition that keeps non-ASCII names (RFC 5987) with a plain ASCII fallback. */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** First markdown heading, else the file name without its extension. */
export function markdownTitle(md: string, file: string): string {
  const h = md.match(/^#{1,2}\s+(.+?)\s*#*\s*$/m);
  return h ? h[1].replace(/[*_`]/g, "").trim() : basename(file).replace(/\.(md|markdown)$/i, "");
}

const PAGE_CSS = `
:root{--bg:#fbfaf7;--text:#1f1e1b;--muted:#74716a;--border:#e2dfd6;--code:#efede7;--link:#2b5fb8;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1a1917;--text:#ecebe6;--muted:#9c998f;--border:#3a3834;--code:#2d2b28;--link:#86aef0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:860px;margin:0 auto;padding:40px 24px 80px}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:2em;margin-top:0}h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid var(--border)}h3{font-size:1.2em}
p,ul,ol,table,pre,blockquote{margin:0 0 1em}
a{color:var(--link)}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.12em .35em;border-radius:4px}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0;font-size:.85em}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
th,td{border:1px solid var(--border);padding:6px 12px;text-align:left;vertical-align:top}th{background:var(--code)}
blockquote{border-left:3px solid var(--border);margin-left:0;padding-left:16px;color:var(--muted)}
hr{border:0;border-top:1px solid var(--border);margin:2em 0}
img{max-width:100%}
`;

/** A self-contained page for a markdown output (published as a claude.ai artifact): no external requests. */
export function markdownPage(md: string, file: string): string {
  const md2html = (Bun as any).markdown?.html as ((s: string, o?: object) => string) | undefined;
  if (!md2html) throw new ShareError(501, `publishing markdown needs Bun 1.3 or newer (running ${Bun.version})`);
  const body = md2html(md, { tables: true, strikethrough: true, tasklists: true, autolinks: true });
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(markdownTitle(md, file))}</title><style>${PAGE_CSS}</style></head>\n<body><main>\n${body}</main></body></html>\n`;
}
