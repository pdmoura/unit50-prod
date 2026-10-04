import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// In-app confirmation for actions that cannot be undone. On phones it sits at
// the bottom of the screen, within thumb reach; on wider screens it is centered.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    // Capture phase, so Escape cancels the dialog and not the panel beneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [busy, onCancel]);
  return createPortal(
    <div
      className="confirm-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <h3 id="confirm-title">{title}</h3>
        <p id="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            className="secondary-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="danger-button" disabled={busy} onClick={onConfirm}>
            {busy ? "Removing…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
