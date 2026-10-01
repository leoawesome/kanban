import { useEffect, useRef } from "react";
import type { Question } from "./api";
import { browserStore, forget } from "./drafts";
import { usePersistentState } from "./usePersistentState";

interface Answer {
  picked: string[];
  otherOn: boolean;
  other: string;
}

function initial(q: Question): Answer {
  const rec = q.options.find((o) => o.recommended) ?? (q.multiSelect ? undefined : q.options[0]);
  return { picked: rec ? [rec.label] : [], otherOn: false, other: "" };
}

/** Progress saved while answering; `sig` ties it to these exact questions. */
interface Progress {
  sig: string;
  answers: Answer[];
  step: number;
  note: string;
}

const signature = (questions: Question[]) => JSON.stringify(questions.map((q) => [q.question, q.options.map((o) => o.label)]));

function fresh(questions: Question[]): Progress {
  return { sig: signature(questions), answers: questions.map(initial), step: 0, note: "" };
}

function answerText(a: Answer): string {
  const parts = [...a.picked, ...(a.otherOn && a.other.trim() ? [a.other.trim()] : [])];
  return parts.length ? parts.join("; ") : "(no preference)";
}

/**
 * Claude's interview questions, one at a time (like Claude Code's question picker).
 * Keys: 1-9 pick an option, Enter goes next, Backspace/← goes back when not typing.
 */
export function QuestionsForm({ questions, answered, disabled, onSubmit, storageKey }: {
  questions: Question[];
  answered: boolean;
  disabled: boolean;
  onSubmit: (text: string) => void;
  /** Where to keep unsent progress so it survives leaving the ticket; omit to not save. */
  storageKey?: string;
}) {
  const sig = signature(questions);
  const [progress, setProgress] = usePersistentState<Progress>(
    answered ? null : storageKey ?? null,
    () => fresh(questions),
    (p) => JSON.stringify(p) === JSON.stringify(fresh(questions)),
    (p) => p?.sig === sig && Array.isArray(p.answers) && p.answers.length === questions.length,
  );
  const { answers, step, note } = progress;
  const setStep = (n: number) => setProgress((p) => ({ ...p, step: n }));
  const setNote = (v: string) => setProgress((p) => ({ ...p, note: v }));
  const setAnswers = (fn: (arr: Answer[]) => Answer[]) => setProgress((p) => ({ ...p, answers: fn(p.answers) }));

  // Answered (here or elsewhere): saved progress is no longer needed.
  useEffect(() => {
    if (answered && storageKey) forget(browserStore(), storageKey);
  }, [answered, storageKey]);
  const root = useRef<HTMLDivElement>(null);
  const total = questions.length;
  const summary = step >= total;
  const q = questions[Math.min(step, total - 1)];
  const a = answers[Math.min(step, total - 1)];

  useEffect(() => {
    if (!answered) root.current?.focus({ preventScroll: true });
  }, [step, answered]);

  const update = (i: number, fn: (a: Answer) => Answer) => setAnswers((arr) => arr.map((x, j) => (j === i ? fn(x) : x)));

  const pick = (label: string) =>
    update(step, (x) => q.multiSelect
      ? { ...x, picked: x.picked.includes(label) ? x.picked.filter((l) => l !== label) : [...x.picked, label] }
      : { ...x, picked: [label], otherOn: false });

  const toggleOther = () =>
    update(step, (x) => ({ ...x, otherOn: !x.otherOn, picked: q.multiSelect || x.otherOn ? x.picked : [] }));

  const send = () => {
    if (storageKey) forget(browserStore(), storageKey);
    const lines = questions.map((qq, i) => `- ${qq.question} → ${answerText(answers[i])}`);
    onSubmit(`My answers:\n${lines.join("\n")}${note.trim() ? `\n\n${note.trim()}` : ""}`);
  };

  const next = () => (step < total - 1 || (total > 1 && step === total - 1) ? setStep(step + 1) : send());

  if (answered) {
    return (
      <div className="qcard answered">
        <div className="qcard-head"><span className="qcard-title">✓ Answered {total} question{total > 1 ? "s" : ""}</span></div>
      </div>
    );
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled || (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
    if (!summary && /^[1-9]$/.test(e.key)) {
      const opt = q.options[Number(e.key) - 1];
      if (opt) pick(opt.label);
      else if (Number(e.key) === q.options.length + 1) toggleOther();
    } else if (e.key === "Enter") {
      e.preventDefault();
      summary ? send() : next();
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && step > 0) {
      e.preventDefault();
      setStep(step - 1);
    }
  };

  return (
    <div className="qcard" ref={root} tabIndex={-1} onKeyDown={onKey}>
      <div className="qcard-head">
        <span className="qcard-title">Claude has {total} question{total > 1 ? "s" : ""}</span>
        <span className="qsteps" aria-label={`Step ${Math.min(step + 1, total)} of ${total}`}>
          {questions.map((_, i) => (
            <button key={i} className={`qstep ${i === step ? "on" : ""} ${i < step || summary ? "done" : ""}`}
              onClick={() => setStep(i)} aria-label={`Question ${i + 1}`} />
          ))}
          <span className="muted small">{summary ? "Review" : `${step + 1} / ${total}`}</span>
        </span>
      </div>

      {!summary ? (
        <div className="qbody">
          <div className="qquestion">{q.question}{q.multiSelect && <span className="muted small"> · pick any</span>}</div>
          <div className="qopts" role={q.multiSelect ? "group" : "radiogroup"}>
            {q.options.map((o, i) => {
              const on = a.picked.includes(o.label);
              return (
                <button key={o.label} type="button" disabled={disabled}
                  className={`qopt ${on ? "on" : ""} ${q.multiSelect ? "multi" : ""}`}
                  role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(o.label)}>
                  <span className="qmark" aria-hidden>{q.multiSelect ? (on ? "✓" : "") : ""}</span>
                  <span className="qtext">
                    <span className="qlabel">
                      {o.label}
                      {o.recommended && <span className="qrec">Recommended</span>}
                    </span>
                    {o.description && <span className="qdesc">{o.description}</span>}
                  </span>
                  <kbd className="qkey">{i + 1}</kbd>
                </button>
              );
            })}
            <button type="button" disabled={disabled} className={`qopt ${a.otherOn ? "on" : ""} ${q.multiSelect ? "multi" : ""}`}
              role={q.multiSelect ? "checkbox" : "radio"} aria-checked={a.otherOn} onClick={toggleOther}>
              <span className="qmark" aria-hidden>{q.multiSelect ? (a.otherOn ? "✓" : "") : ""}</span>
              <span className="qtext"><span className="qlabel">Other…</span><span className="qdesc">Type your own answer</span></span>
              <kbd className="qkey">{q.options.length + 1}</kbd>
            </button>
            {a.otherOn && (
              <input autoFocus className="qother" value={a.other} placeholder="Your answer"
                onChange={(e) => update(step, (x) => ({ ...x, other: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); next(); } }} />
            )}
          </div>
        </div>
      ) : (
        <div className="qbody">
          <ol className="qsummary">
            {questions.map((qq, i) => (
              <li key={i}>
                <button className="link-btn" onClick={() => setStep(i)}>{qq.question}</button>
                <span>{answerText(answers[i])}</span>
              </li>
            ))}
          </ol>
          <input className="qother" value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled}
            placeholder="Anything else Claude should know? (optional)"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }} />
        </div>
      )}

      <div className="qfoot">
        <button className="btn ghost small" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <span className="muted small qhint">{summary ? "Enter to send" : "1-9 to pick · Enter for next"}</span>
        {summary || total === 1 ? (
          <button className="btn primary small" disabled={disabled} onClick={send}>Send answers</button>
        ) : (
          <button className="btn primary small" disabled={disabled} onClick={next}>{step === total - 1 ? "Review →" : "Next →"}</button>
        )}
      </div>
    </div>
  );
}
