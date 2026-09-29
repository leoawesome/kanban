import type { TicketMode } from "./api";

const OPTIONS: { value: TicketMode; label: string; hint: string }[] = [
  { value: "interview", label: "Interview me first", hint: "Claude asks clarifying questions before doing the work" },
  { value: "auto", label: "Just do it", hint: "Claude works autonomously with its own judgement" },
];

export function ModeToggle({ value, onChange, disabled }: { value: TicketMode; onChange: (m: TicketMode) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="How Claude works on this ticket">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.hint} disabled={disabled}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
