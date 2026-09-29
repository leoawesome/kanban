import { useEffect, useRef, useState, type ReactNode } from "react";

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

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
      <div className="modal confirm" role="alertdialog" aria-label={title}>
        <div className="confirm-body">
          <h3>{title}</h3>
          <div className="confirm-text">{children}</div>
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="form-actions confirm-actions">
          <button ref={cancelRef} className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={confirm} disabled={busy}>{busy ? "Deleting…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
