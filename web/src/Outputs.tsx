import { useEffect, useMemo, useState } from "react";
import { api, subscribe, type OutputFile } from "./api";
import { autoGrow } from "./autoGrow";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "./icons";
import { fullTime, timeAgo, useNow } from "./time";
import { toast } from "./toast";
import { Markdown } from "./Transcript";

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Raster images the server serves with their real type (SVG stays text there, so it is not previewed). */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const BINARY = /\.(ico|bmp|tiff?|psd|pdf|zip|gz|tgz|tar|7z|rar|mp3|wav|m4a|ogg|mp4|mov|webm|avi|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat|db|sqlite|wasm|pyc|class|jar|heic|avif)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const HTML = /\.html?$/i;
/** Planning mockups (outputs/mockups/*.html) get Approve / Request changes; approved.html is the board's copy. */
const MOCKUP = /^mockups\/[^/]+\.html?$/i;
const APPROVED = "mockups/approved.html";
/** Show the filter once the list gets long. */
const FILTER_MIN = 10;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Folder paths containing a file: "a/b/c.png" -> ["a", "a/b"]. */
const ancestors = (path: string) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));

interface Folder { path: string; name: string; folders: Folder[]; files: OutputFile[]; count: number }

function buildTree(files: OutputFile[]): Folder {
  const root: Folder = { path: "", name: "", folders: [], files: [], count: 0 };
  const byPath = new Map([["", root]]);
  for (const f of files) {
    let dir = root;
    for (const p of ancestors(f.name)) {
      let next = byPath.get(p);
      if (!next) {
        next = { path: p, name: baseName(p), folders: [], files: [], count: 0 };
        byPath.set(p, next);
        dir.folders.push(next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  const sort = (d: Folder): number => {
    d.folders.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
    d.count = d.files.length + d.folders.reduce((n, s) => n + sort(s), 0);
    return d.count;
  };
  sort(root);
  return root;
}

function fileIcon(name: string) {
  if (IMAGE.test(name) || /\.svg$/i.test(name)) return <FileImageIcon />;
  if (HTML.test(name)) return <FileCodeIcon />;
  if (BINARY.test(name)) return <FileIcon />;
  return <FileTextIcon />;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Claude-written HTML only ever runs in an opaque-origin frame (sandbox without allow-same-origin), so it can't
 * reach the board's API. A new tab gets a script-free page on a blob URL that wraps the same sandboxed frame.
 */
function openInTab(name: string, html: string) {
  const page = `<!doctype html><meta charset="utf-8"><title>${escapeAttr(name)}</title>`
    + `<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>`
    + `<iframe sandbox="allow-scripts" srcdoc="${escapeAttr(html)}"></iframe>`;
  const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Approve a planning mockup or ask Claude to change it; both continue the planning chat. */
function MockupActions({ slug, ticketId, name, onSent }: { slug: string; ticketId: string; name: string; onSent?: () => void }) {
  const [changes, setChanges] = useState("");
  const [busy, setBusy] = useState<"approve" | "changes" | null>(null);
  useEffect(() => setChanges(""), [name]);
  const run = async (kind: "approve" | "changes") => {
    setBusy(kind);
    try {
      if (kind === "approve") await api.approveMockup(slug, ticketId, name);
      else await api.chat(slug, ticketId, `Changes for ${name}: ${changes.trim()}`);
      toast(kind === "approve" ? `Approved ${baseName(name)}. Claude is writing the final ticket.` : `Sent your changes for ${baseName(name)} to Claude.`, { tone: "ok" });
      setChanges("");
      onSent?.();
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  if (name === APPROVED) return <div className="mockup-actions muted small">This is the approved design. The dev run builds against it.</div>;
  return (
    <div className="mockup-actions">
      <textarea value={changes} rows={1} placeholder="What should change in this mockup?" aria-label="Changes for this mockup"
        onChange={(e) => { setChanges(e.target.value); autoGrow(e.target); }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && changes.trim() && !busy) { e.preventDefault(); run("changes"); } }} />
      <button className="btn" disabled={!changes.trim() || !!busy} onClick={() => run("changes")}>
        {busy === "changes" ? "Sending…" : "Request changes"}
      </button>
      <button className="btn primary" disabled={!!busy} onClick={() => run("approve")} title="Keep this as mockups/approved.html and let Claude write the final ticket">
        {busy === "approve" ? "Approving…" : "Approve"}
      </button>
    </div>
  );
}

/** Deliverables Claude saved in the ticket's outputs folder; markdown is rendered, images and HTML previewed, other text shown raw. */
export function Outputs({ slug, ticketId, onCount, focus, planning, onSent }: {
  slug: string;
  ticketId: string;
  onCount?: (n: number) => void;
  /** File to show first (path relative to outputs), e.g. a mockup clicked in the chat. */
  focus?: string | null;
  /** The ticket is in Planning: mockups can be approved or sent back with changes. */
  planning?: boolean;
  /** A mockup approval or change request went to Claude. */
  onSent?: () => void;
}) {
  const [files, setFiles] = useState<OutputFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  useNow();

  const load = () => api.outputs(slug, ticketId).then((fs) => {
    setError(null);
    setFiles(fs);
    onCount?.(fs.length);
    setOpen((cur) => (cur && fs.some((f) => f.name === cur) ? cur : null) ?? fs.find((f) => MARKDOWN.test(f.name))?.name ?? fs[0]?.name ?? null);
  }).catch((e) => {
    setError(e.message);
    setFiles((f) => f ?? []);
  });

  useEffect(() => { load(); }, [slug, ticketId]);
  useEffect(() => subscribe((e) => {
    if ((e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticketId)
      || (e.type === "session.updated" && e.profile === slug && e.id === ticketId)) load();
  }), [slug, ticketId]);

  const current = files?.find((f) => f.name === open);
  const kind = !open ? null : IMAGE.test(open) ? "image" : BINARY.test(open) ? "binary" : HTML.test(open) ? "html" : "text";
  useEffect(() => {
    setText(null);
    if (!open || (kind !== "text" && kind !== "html")) return;
    api.outputText(slug, ticketId, open).then(setText).catch((e) => setText(`Could not load: ${e.message}`));
  }, [slug, ticketId, open, kind, current?.updatedAt]);

  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => (files && needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files ?? []), [files, needle]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  // The selected file's folders always stay open; while filtering every match is visible.
  const forcedOpen = useMemo(() => new Set(open ? ancestors(open) : []), [open]);
  const isOpen = (path: string) => !!needle || forcedOpen.has(path) || !collapsed.has(path);
  const toggle = (path: string) => setCollapsed((c) => {
    const next = new Set(c);
    if (isOpen(path)) next.add(path); else next.delete(path);
    return next;
  });

  if (files === null) return <div className="muted"><span className="spinner" /> Loading…</div>;
  if (error && !files.length) {
    return (
      <div className="banner error inline load-error" role="alert">
        Couldn't load the outputs: {error} <button className="link-btn" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!files.length) return <div className="muted">No outputs yet. Research and writing tasks save their report here.</div>;

  const pad = (depth: number) => ({ paddingLeft: 8 + depth * 14 });
  const renderFolder = (d: Folder, depth: number): React.ReactNode => (
    <>
      {d.folders.map((s) => (
        <div key={s.path} role="none">
          <button className="tree-row" style={pad(depth)} title={s.path} role="treeitem" aria-expanded={isOpen(s.path)}
            disabled={!!needle || forcedOpen.has(s.path)} onClick={() => toggle(s.path)}>
            <span className="tree-caret" aria-hidden>{isOpen(s.path) ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}</span>
            <span className="tree-icon" aria-hidden>{isOpen(s.path) ? <FolderOpenIcon /> : <FolderIcon />}</span>
            <span className="tree-dir output-name">{s.name}</span>
            <span className="output-count muted small">{s.count}</span>
          </button>
          {isOpen(s.path) && <div role="group">{renderFolder(s, depth + 1)}</div>}
        </div>
      ))}
      {d.files.map((f) => (
        <button key={f.name} className={`tree-row output-file${f.name === open ? " selected" : ""}`} style={pad(depth)} title={f.name}
          role="treeitem" aria-selected={f.name === open} onClick={() => setOpen(f.name)}>
          <span className="tree-caret" aria-hidden />
          <span className="tree-icon" aria-hidden>{fileIcon(f.name)}</span>
          <span className="output-label">
            <span className="output-name">{baseName(f.name)}</span>
            <span className="output-meta muted" title={fullTime(f.updatedAt)}>{kb(f.size)} · {timeAgo(f.updatedAt)}</span>
          </span>
        </button>
      ))}
    </>
  );

  const rawUrl = open ? api.outputUrl(slug, ticketId, open) : "";
  const binaryNote = (
    <div className="output-binary muted">
      Binary file, {kb(current?.size ?? 0)}, no preview. <a href={rawUrl} target="_blank" rel="noreferrer">Open raw</a>
    </div>
  );

  return (
    <div className="outputs">
      <div className="output-side">
        {files.length > FILTER_MIN && (
          <div className="file-filter">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter outputs…" aria-label="Filter outputs"
              onKeyDown={(e) => { if (e.key === "Escape" && filter) { e.preventDefault(); e.stopPropagation(); setFilter(""); } }} />
            {filter && <button className="search-clear" aria-label="Clear filter" onClick={() => setFilter("")}><CloseIcon size={12} /></button>}
          </div>
        )}
        <nav className="file-tree output-files" aria-label="Outputs" role="tree">
          {shown.length ? renderFolder(tree, 0) : <div className="tree-note muted small">No matches</div>}
        </nav>
      </div>
      <div className={`output-view${kind === "html" ? " html" : ""}`}>
        {kind === "html" && open && (
          <div className="output-html-bar">
            {planning && MOCKUP.test(open) && <MockupActions slug={slug} ticketId={ticketId} name={open} onSent={onSent} />}
            <button className="link-btn small" disabled={text === null} onClick={() => text !== null && openInTab(open, text)}>Open in new tab</button>
          </div>
        )}
        {kind === "html" ? (
          text === null ? <div className="muted output-html-note">Loading…</div>
            : <iframe className="output-html" sandbox="allow-scripts" srcDoc={text} title={`Preview of ${open}`} />
        ) : kind === "image" ? (
          <div className="output-image"><img src={`${rawUrl}?v=${encodeURIComponent(current?.updatedAt ?? "")}`} alt={open ?? ""} /></div>
        ) : kind === "binary" ? binaryNote
          : text === null ? <div className="muted">Loading…</div>
          : text.slice(0, 8000).includes("\0") ? binaryNote
          : open && MARKDOWN.test(open) ? <Markdown text={text} />
          : <pre>{text.length > 200_000 ? text.slice(0, 200_000) + "\n…(truncated)" : text}</pre>}
      </div>
    </div>
  );
}
