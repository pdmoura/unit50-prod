import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { LogoSpinner } from "./Logo";

// In-app confirmation before an action that is hard to take back. On phones it
// sits at the bottom of the screen, within thumb reach; on wider screens it is
// centered. The red button is for deleting; "primary" is for anything else.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel = "Removing…",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "danger" | "primary";
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
          <button
            className={`${tone === "danger" ? "danger-button" : "primary-button"} ${busy ? "is-busy" : ""}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <LogoSpinner />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
