import { useState } from "react";
import type { Question } from "./api";

/** Claude's interview questions as a form; answers are sent back as one chat message. */
export function QuestionsForm({ questions, answered, disabled, onSubmit }: {
  questions: Question[];
  answered: boolean;
  disabled: boolean;
  onSubmit: (text: string) => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() =>
    questions.map((q) => {
      const rec = q.options.find((o) => o.recommended) ?? (q.multiSelect ? undefined : q.options[0]);
      return rec ? [rec.label] : [];
    }));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [note, setNote] = useState("");

  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked((p) => p.map((sel, i) => (i !== qi ? sel : multi ? (sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]) : [label])));

  const submit = () => {
    const lines = questions.map((q, i) => {
      const parts = [...picked[i], ...(other[i].trim() ? [other[i].trim()] : [])];
      return `- ${q.question} → ${parts.length ? parts.join("; ") : "(no preference)"}`;
    });
    onSubmit(`My answers:\n${lines.join("\n")}${note.trim() ? `\n\n${note.trim()}` : ""}`);
  };

  return (
    <div className={`qform ${answered ? "answered" : ""}`}>
      {questions.map((q, qi) => (
        <fieldset key={qi} className="q" disabled={answered || disabled}>
          <legend>{qi + 1}. {q.question}{q.multiSelect && <span className="muted small"> (pick any)</span>}</legend>
          {q.options.map((o) => {
            const on = picked[qi].includes(o.label);
            return (
              <label key={o.label} className={`q-opt ${on ? "on" : ""}`}>
                <input type={q.multiSelect ? "checkbox" : "radio"} name={`q${qi}`} checked={on}
                  onChange={() => toggle(qi, o.label, q.multiSelect)} />
                <span>
                  <b>{o.label}</b>{o.recommended && <span className="q-rec">Recommended</span>}
                  {o.description && <span className="q-desc">{o.description}</span>}
                </span>
              </label>
            );
          })}
          <input className="q-other" value={other[qi]} placeholder="Other / add detail (optional)"
            onChange={(e) => setOther((arr) => arr.map((v, i) => (i === qi ? e.target.value : v)))} />
        </fieldset>
      ))}
      {!answered && (
        <div className="q-foot">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else Claude should know? (optional)" disabled={disabled} />
          <button className="btn primary" onClick={submit} disabled={disabled}>Send answers</button>
        </div>
      )}
      {answered && <div className="muted small">Answered</div>}
    </div>
  );
}
