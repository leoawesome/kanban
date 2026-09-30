import hljs from "highlight.js/lib/common";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type FileContent, type FileEntry } from "./api";

type Dir = FileEntry[] | "loading" | { error: string };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

function CodeView({ file }: { file: FileContent }) {
  const html = useMemo(() => (file.content === null ? null : highlight(file.path, file.content)), [file]);
  if (file.tooLarge) return <div className="empty small">File is too large to show ({formatSize(file.size)}).</div>;
  if (file.binary) return <div className="empty small">Binary file ({formatSize(file.size)}), not shown.</div>;
  const text = file.content ?? "";
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  return (
    <div className="code-view">
      <pre className="code-gutter" aria-hidden>{Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join("\n")}</pre>
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

  const load = useCallback((path: string) => {
    setDirs((m) => new Map(m).set(path, "loading"));
    api.files(slug, path)
      .then((r) => setDirs((m) => new Map(m).set(path, r.entries)))
      .catch((e) => setDirs((m) => new Map(m).set(path, { error: e.message })));
  }, [slug]);

  const openFile = useCallback((path: string) => {
    setSelected(path);
    setFile("loading");
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

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const d = dirs.get(path);
    const pad = { paddingLeft: 8 + depth * 14 };
    if (!d || d === "loading") return <div className="tree-note muted small" style={pad}>Loading…</div>;
    if ("error" in d) return <div className="tree-note small err-text" style={pad}>{d.error}</div>;
    if (!d.length && depth > 0) return <div className="tree-note muted small" style={pad}>Empty</div>;
    return d.map((e) => (
      <div key={e.path}>
        <button
          className={`tree-row${selected === e.path ? " selected" : ""}`}
          style={pad}
          title={e.path}
          onClick={() => (e.type === "dir" ? toggle(e.path) : openFile(e.path))}
        >
          <span className="tree-caret">{e.type === "dir" ? (expanded.has(e.path) ? "▾" : "▸") : ""}</span>
          <span className={e.type === "dir" ? "tree-dir" : undefined}>{e.name}</span>
        </button>
        {e.type === "dir" && expanded.has(e.path) && renderDir(e.path, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="files-view">
      <nav className="file-tree" aria-label="Files">{renderDir("", 0)}</nav>
      <div className="file-viewer">
        {selected && <div className="file-viewer-head" title={selected}>{selected}</div>}
        <div className="file-viewer-body">
          {!selected ? <div className="empty small">Pick a file to view it.</div>
            : file === "loading" || file === null ? <div className="empty small">Loading…</div>
            : "error" in file ? <div className="empty small err-text">{file.error}</div>
            : <CodeView file={file} />}
        </div>
      </div>
    </div>
  );
}
