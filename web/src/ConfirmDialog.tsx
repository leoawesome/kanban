import { useId, useRef, useState, type ReactNode } from "react";
import { useFocusTrap, useLayer } from "./layers";

export function ConfirmDialog({ title, children, confirmLabel, busyLabel = "Working…", tone = "danger", onConfirm, onCancel }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayer(onCancel);
  useFocusTrap(box);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="overlay confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={box} className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby={id}>
        <div className="confirm-body">
          <h3 id={id}>{title}</h3>
          <div className="confirm-text">{children}</div>
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="form-actions confirm-actions">
          <button ref={cancelRef} className="btn ghost" onClick={onCancel} autoFocus>Cancel</button>
          <button className={`btn ${tone}`} onClick={confirm} disabled={busy}>{busy ? busyLabel : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
