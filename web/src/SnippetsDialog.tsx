import { useEffect, useState } from "react";
import { api, type Profile, type Snippet } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { PlusIcon } from "./icons";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { firstLine } from "./snippetText";
import { reloadSnippets, useSnippets } from "./snippets";

type Draft = { name: string; scope: string; text: string };
const blank = (): Draft => ({ name: "", scope: "global", text: "" });

/** ⋯ → Snippets: reusable prompt text, inserted by typing `@name` in a ticket description or the chat. */
export function SnippetsDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const snippets = useSnippets(profile.slug);
  // Snippet being edited: an id, "new", or null before the list has loaded.
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saved, setSaved] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Snippet | null>(null);

  const pick = (s: Snippet | null) => {
    const d = s ? { name: s.name, scope: s.scope, text: s.text } : blank();
    setSel(s?.id ?? "new");
    setDraft(d);
    setSaved(d);
    setErr(null);
  };

  // First load: open the first snippet, or a blank form when there are none.
  useEffect(() => {
    if (snippets && sel === null) pick(snippets[0] ?? null);
    // A snippet deleted elsewhere: fall back to the first one.
    if (snippets && sel && sel !== "new" && !snippets.some((s) => s.id === sel)) pick(snippets[0] ?? null);
  }, [snippets, sel]);

  const dirty = draft.name !== saved.name || draft.scope !== saved.scope || draft.text !== saved.text;
  const current = snippets?.find((s) => s.id === sel) ?? null;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const input = { name: draft.name.trim().replace(/^@/, ""), scope: draft.scope, text: draft.text };
      const s = current ? await api.updateSnippet(current.id, input) : await api.createSnippet(input);
      const d = { name: s.name, scope: s.scope, text: s.text };
      await reloadSnippets(profile.slug);
      setSel(s.id);
      setDraft(d);
      setSaved(d);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = (s: Snippet) => (s.scope === "global" ? "All boards" : "This board");

  return (
    <Modal title="Snippets" onClose={onClose} wide guard={dirty}>
      <div className="snippets">
        <div className="snippet-names">
          <button className="btn small snippet-new" onClick={() => pick(null)} disabled={sel === "new" && !dirty}>
            <PlusIcon size={12} /> New
          </button>
          {snippets?.map((s) => (
            <button key={s.id} className={`snippet-name${s.id === sel ? " on" : ""}`} onClick={() => pick(s)} title={firstLine(s.text)}>
              <span className="mono">@{s.name}</span>
              <span className="muted small">{scopeLabel(s)}</span>
            </button>
          ))}
          {snippets && !snippets.length && (
            <div className="muted small snippet-hint">
              No snippets yet. Save text you keep retyping (e.g. "run the e2e tests before finishing"), then type <code>@name</code> in a
              new ticket, a description or the chat to insert it.
            </div>
          )}
        </div>
        <form className="form snippet-editor" onSubmit={(e) => { e.preventDefault(); save(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}>
          <label>
            Name
            <input className="mono" value={draft.name} placeholder="e2e" spellCheck={false} autoFocus
              onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase().replace(/\s+/g, "-") })} />
            <span className="muted small">Lowercase letters, digits and dashes. Type <code>@{draft.name.trim() || "name"}</code> to insert it.</span>
          </label>
          <div className="field">
            <div className="field-label">Available on</div>
            <Select ariaLabel="Available on" value={draft.scope} onChange={(scope) => setDraft({ ...draft, scope })}
              options={[{ value: "global", label: "All boards" }, { value: profile.slug, label: `This board only (${profile.name})` }]} />
          </div>
          <label>
            Text
            <textarea rows={9} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder="Before finishing, run the test suite and fix any failures." />
          </label>
          {err && <div className="form-error">{err}</div>}
          <div className="form-actions">
            {current && <button type="button" className="btn ghost danger" onClick={() => setConfirm(current)}>Delete</button>}
            <span className="spacer" />
            {dirty && <button type="button" className="btn ghost" onClick={() => { setDraft(saved); setErr(null); }}>Revert</button>}
            <button type="submit" className="btn primary" disabled={busy || !dirty || !draft.name.trim() || !draft.text.trim()}>
              {busy ? "Saving…" : current ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
      {confirm && (
        <ConfirmDialog title={`Delete @${confirm.name}?`} confirmLabel="Delete" busyLabel="Deleting…" onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteSnippet(confirm.id);
            await reloadSnippets(profile.slug);
            setConfirm(null);
            setSel(null);
          }}>
          <p>Text already inserted into tickets stays as it is.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
