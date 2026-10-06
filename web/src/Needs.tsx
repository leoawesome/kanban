import { useState } from "react";
import { api, type Ticket } from "./api";
import { CloseIcon, DeviceIcon } from "./icons";

/** One resource a ticket needs; held: this ticket is using it right now. */
export function ResourceChip({ name, held }: { name: string; held?: boolean }) {
  return (
    <span className={`res-chip ${held ? "held" : ""}`} title={held ? `Using ${name} now` : `Needs ${name}`}>
      <DeviceIcon size={11} strokeWidth={1.7} /> {name}
    </span>
  );
}

/** Resources another ticket holds while this one would start (Ready, or Backlog in a running plan). */
export function resourceWait(t: Ticket): string[] {
  return t.running || t.status === "in_progress" ? [] : t.resources?.waitingFor ?? [];
}

/** Ticket drawer field: the exclusive resources (Ticket.needs) this ticket's runs use. */
export function NeedsField({ slug, ticket, onError }: { slug: string; ticket: Ticket; onError: (msg: string) => void }) {
  const needs = ticket.needs ?? [];
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (next: string[]) => {
    setBusy(true);
    try {
      await api.updateTicket(slug, ticket.id, { needs: next });
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const names = draft.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && !needs.includes(x));
    setDraft("");
    if (names.length) void save([...needs, ...names]);
  };
  return (
    <div className="needs-field">
      <span className="field-key" title="Exclusive resources this ticket's runs use">Needs</span>
      <div className="needs-chips">
        {needs.map((n) => (
          <span key={n} className="chip on needs-chip">
            {n}
            <button className="link-btn" aria-label={`Remove ${n}`} disabled={busy} onClick={() => save(needs.filter((x) => x !== n))}>
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        <input value={draft} disabled={busy} placeholder={needs.length ? "Add…" : "Add resource…"} aria-label="Add a resource"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && needs.length) void save(needs.slice(0, -1));
          }} />
      </div>
      <span className="field-help">Tickets that need the same thing never run at the same time. Order doesn't matter.</span>
    </div>
  );
}
