import hljs from "highlight.js/lib/common";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, copy, type FileContent, type FileEntry } from "./api";
import {
  CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, CopyIcon, ExternalIcon, FileCodeIcon, FileIcon, FileImageIcon,
  FileTextIcon, FolderIcon, FolderOpenIcon,
} from "./icons";
import { toast } from "./toast";

type Dir = FileEntry[] | "loading" | { error: string };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|zsh|bash|yml|yaml|toml|css|scss|html|xml|sql|vue|svelte)$/i;
const TEXT = /\.(md|markdown|txt|rst|csv|log)$|^(readme|license|changelog)/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;

function FileTypeIcon({ name }: { name: string }) {
  if (IMAGE.test(name)) return <FileImageIcon />;
  if (CODE.test(name)) return <FileCodeIcon />;
  if (TEXT.test(name)) return <FileTextIcon />;
  return <FileIcon />;
}

/** Language from the file extension; falls back to plain text (no auto-detect: slow and often wrong). */
function highlight(path: string, text: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  const lang = hljs.getLanguage(ext) ? ext : name === "dockerfile" ? "dockerfile" : name === "makefile" ? "makefile" : null;
  if (!lang || !hljs.getLanguage(lang)) return null;
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

const GUTTER_CHUNK = 2000;

/** Line numbers are built in chunks as you scroll, so a huge file doesn't build one giant string up front. */
function CodeView({ file, scroller }: { file: FileContent; scroller: React.RefObject<HTMLDivElement | null> }) {
  const html = useMemo(() => (file.content === null ? null : highlight(file.path, file.content)), [file]);
  const text = file.content ?? "";
  const lines = useMemo(() => Math.max(1, text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length), [text]);
  const [shown, setShown] = useState(Math.min(lines, GUTTER_CHUNK));
  useEffect(() => setShown(Math.min(lines, GUTTER_CHUNK)), [lines]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || shown >= lines) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight * 2 > el.scrollHeight * (shown / lines)) setShown((n) => Math.min(lines, n + GUTTER_CHUNK));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scroller, shown, lines]);
  const gutter = useMemo(() => Array.from({ length: shown }, (_, i) => i + 1).join("\n"), [shown]);
  if (file.tooLarge) return <div className="empty small">File is too large to show ({formatSize(file.size)}).</div>;
  if (file.binary) return <div className="empty small">Binary file ({formatSize(file.size)}), not shown.</div>;
  return (
    <div className="code-view">
      <pre className="code-gutter" aria-hidden>{gutter}</pre>
      {html !== null
        ? <pre className="code-text hljs" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="code-text">{text}</pre>}
    </div>
  );
}

/** Read-only tree of the profile folder (gitignored entries hidden) with a file viewer. */
export function FilesView({ slug, refreshSignal }: { slug: string; refreshSignal: number }) {
  const [dirs, setDirs] = useState<Map<string, Dir>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | { error: string } | "loading" | null>(null);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const load = useCallback((path: string) => {
    setDirs((m) => new Map(m).set(path, "loading"));
    api.files(slug, path)
      .then((r) => setDirs((m) => new Map(m).set(path, r.entries)))
      .catch((e) => setDirs((m) => new Map(m).set(path, { error: e.message })));
  }, [slug]);

  const openFile = useCallback((path: string) => {
    setSelected(path);
    setFile("loading");
    setCopied(false);
    api.file(slug, path).then(setFile).catch((e) => setFile({ error: e.message }));
  }, [slug]);

  // Initial load, and Refresh: reload the root and every open folder, and the open file.
  useEffect(() => {
    load("");
    for (const p of expanded) load(p);
    if (selected) openFile(selected);
  }, [refreshSignal]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!dirs.has(path)) load(path);
    }
    setExpanded(next);
  };

  // Filter over every folder loaded so far (the tree loads lazily, one level at a time).
  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    const out: FileEntry[] = [];
    for (const d of dirs.values()) if (Array.isArray(d)) for (const e of d) if (e.path.toLowerCase().includes(needle)) out.push(e);
    return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 300);
  }, [dirs, needle]);

  const onTreeKey = (e: React.KeyboardEvent) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".tree-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const row = rows[at];
    const path = row.dataset.path!;
    const isDir = row.dataset.type === "dir";
    if (e.key === "ArrowDown") { e.preventDefault(); rows[Math.min(rows.length - 1, at + 1)]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); rows[Math.max(0, at - 1)]?.focus(); }
    else if (e.key === "ArrowRight" && isDir && !expanded.has(path)) { e.preventDefault(); toggle(path); }
    else if (e.key === "ArrowLeft" && isDir && expanded.has(path)) { e.preventDefault(); toggle(path); }
    else if (e.key === "ArrowLeft") {
      // Up to the parent folder.
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent) { e.preventDefault(); rows.find((r) => r.dataset.path === parent)?.focus(); }
    }
  };

  const renderRow = (e: FileEntry, depth: number, flat = false) => (
    <button
      key={flat ? `m:${e.path}` : undefined}
      className={`tree-row${selected === e.path ? " selected" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={e.path}
      role="treeitem"
      aria-expanded={e.type === "dir" && !flat ? expanded.has(e.path) : undefined}
      aria-selected={selected === e.path}
      data-path={e.path}
      data-type={e.type}
      onClick={() => {
        if (e.type === "dir") {
          if (flat) setFilter("");
          if (!flat || !expanded.has(e.path)) toggle(e.path);
        } else openFile(e.path);
      }}
    >
      <span className="tree-caret" aria-hidden>
        {e.type === "dir" && !flat ? (expanded.has(e.path) ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />) : null}
      </span>
      <span className="tree-icon" aria-hidden>
        {e.type === "dir" ? (expanded.has(e.path) ? <FolderOpenIcon /> : <FolderIcon />) : <FileTypeIcon name={e.name} />}
      </span>
      <span className={e.type === "dir" ? "tree-dir" : undefined}>{flat ? e.path : e.name}</span>
    </button>
  );

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const d = dirs.get(path);
    const pad = { paddingLeft: 8 + depth * 14 };
    if (!d || d === "loading") return <div className="tree-note muted small" style={pad}>Loading…</div>;
    if ("error" in d) return <div className="tree-note small err-text" style={pad}>{d.error}</div>;
    if (!d.length && depth > 0) return <div className="tree-note muted small" style={pad}>Empty</div>;
    return d.map((e) => (
      <div key={e.path} role="none">
        {renderRow(e, depth)}
        {e.type === "dir" && expanded.has(e.path) && <div role="group">{renderDir(e.path, depth + 1)}</div>}
      </div>
    ));
  };

  const current = file && file !== "loading" && !("error" in file) ? file : null;

  return (
    <div className="files-view">
      <div className="file-side">
        <div className="file-filter">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" aria-label="Filter files"
            onKeyDown={(e) => { if (e.key === "Escape" && filter) { e.preventDefault(); e.stopPropagation(); setFilter(""); } }} />
          {filter && (
            <button className="search-clear" aria-label="Clear filter" onClick={() => setFilter("")}><CloseIcon size={12} /></button>
          )}
        </div>
        <nav className="file-tree" aria-label="Files" role="tree" onKeyDown={onTreeKey}>
          {needle ? (
            <>
              {matches.map((e) => renderRow(e, 0, true))}
              <div className="tree-note muted small">
                {matches.length ? "" : "No match. "}Searches folders you've opened so far.
              </div>
            </>
          ) : renderDir("", 0)}
        </nav>
      </div>
      <div className="file-viewer">
        {selected && (
          <div className="file-viewer-head">
            <span className="file-viewer-path" title={selected}>{selected}</span>
            {current && <span className="muted">{formatSize(current.size)}</span>}
            <button className="icon-btn tiny" aria-label="Copy path" title="Copy path (relative to the folder)"
              onClick={async () => { await copy(selected); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            </button>
            <button className="icon-btn tiny" aria-label="Open in default app" title="Open in its default app"
              onClick={() => api.openFile(slug, selected).catch((e) => toast(`Couldn't open it: ${e.message}`, { tone: "error" }))}>
              <ExternalIcon size={12} />
            </button>
          </div>
        )}
        <div className="file-viewer-body" ref={body}>
          {!selected ? <div className="empty small">Pick a file to view it.</div>
            : file === "loading" || file === null ? <div className="empty small">Loading…</div>
            : "error" in file ? <div className="empty small err-text">{file.error}</div>
            : <CodeView file={file} scroller={body} />}
        </div>
      </div>
    </div>
  );
}
