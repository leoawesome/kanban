import { useEffect, useMemo, useState } from "react";
import { api, subscribe, type OutputFile } from "./api";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FileIcon, FileImageIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "./icons";
import { fullTime, timeAgo, useNow } from "./time";
import { Markdown } from "./Transcript";

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Raster images the server serves with their real type (SVG stays text there, so it is not previewed). */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const BINARY = /\.(ico|bmp|tiff?|psd|pdf|zip|gz|tgz|tar|7z|rar|mp3|wav|m4a|ogg|mp4|mov|webm|avi|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat|db|sqlite|wasm|pyc|class|jar|heic|avif)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
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
  if (BINARY.test(name)) return <FileIcon />;
  return <FileTextIcon />;
}

/** Deliverables Claude saved in the ticket's outputs folder; markdown is rendered, images previewed, other text shown raw. */
export function Outputs({ slug, ticketId, onCount }: { slug: string; ticketId: string; onCount?: (n: number) => void }) {
  const [files, setFiles] = useState<OutputFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
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
  const kind = !open ? null : IMAGE.test(open) ? "image" : BINARY.test(open) ? "binary" : "text";
  useEffect(() => {
    setText(null);
    if (!open || kind !== "text") return;
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
      <div className="output-view">
        {kind === "image" ? (
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
