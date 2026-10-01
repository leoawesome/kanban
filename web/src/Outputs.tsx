import { useEffect, useState } from "react";
import { api, subscribe, type OutputFile } from "./api";
import { fullTime, timeAgo, useNow } from "./time";
import { Markdown } from "./Transcript";

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Deliverables Claude saved in the ticket's outputs folder; markdown is rendered, other text shown raw. */
export function Outputs({ slug, ticketId, onCount }: { slug: string; ticketId: string; onCount?: (n: number) => void }) {
  const [files, setFiles] = useState<OutputFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useNow();

  const load = () => api.outputs(slug, ticketId).then((fs) => {
    setError(null);
    setFiles(fs);
    onCount?.(fs.length);
    setOpen((cur) => cur ?? fs.find((f) => f.name.endsWith(".md"))?.name ?? fs[0]?.name ?? null);
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
  useEffect(() => {
    if (!open) return setText(null);
    setText(null);
    api.outputText(slug, ticketId, open).then(setText).catch((e) => setText(`Could not load: ${e.message}`));
  }, [slug, ticketId, open, current?.updatedAt]);

  if (files === null) return <div className="muted"><span className="spinner" /> Loading…</div>;
  if (error && !files.length) {
    return (
      <div className="banner error inline load-error" role="alert">
        Couldn't load the outputs: {error} <button className="link-btn" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!files.length) return <div className="muted">No outputs yet. Research and writing tasks save their report here.</div>;

  return (
    <div className="outputs">
      <div className="output-files">
        {files.map((f) => (
          <button key={f.name} className={`output-file ${f.name === open ? "on" : ""}`} onClick={() => setOpen(f.name)}>
            <span className="output-name">{f.name}</span>
            <span className="muted small" title={fullTime(f.updatedAt)}>{kb(f.size)} · {timeAgo(f.updatedAt)}</span>
          </button>
        ))}
      </div>
      <div className="output-view">
        {text === null ? <div className="muted">Loading…</div>
          : open?.match(/\.(md|markdown)$/i) ? <Markdown text={text} />
          : <pre>{text.length > 200_000 ? text.slice(0, 200_000) + "\n…(truncated)" : text}</pre>}
      </div>
    </div>
  );
}
