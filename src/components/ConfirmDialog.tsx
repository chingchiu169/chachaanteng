import { ReactNode, useEffect, useRef } from "react";

interface Props {
  open: boolean;
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action — red confirm button. */
  danger?: boolean;
  /** Runs the action; the parent closes by setting `open` to false. */
  onConfirm: () => void;
  /** Fired when the dialog is closed WITHOUT confirming (cancel / Esc / backdrop click). */
  onCancel: () => void;
}

/**
 * Confirm dialog — daisyUI Modal, Method 1 (native `<dialog class="modal">`).
 * The Tauri webview suppresses window.confirm, so every confirm in the app goes through here.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  /** Tracks the shown state ourselves — StrictMode double-invokes effects. */
  const shownRef = useRef(false);
  /** Set when the user confirms so the resulting close event doesn't also fire onCancel. */
  const confirmedRef = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !shownRef.current) {
      confirmedRef.current = false;
      shownRef.current = true;
      d.showModal();
    } else if (!open && shownRef.current) {
      shownRef.current = false;
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={() => {
        shownRef.current = false;
        if (!confirmedRef.current) onCancel();
      }}
    >
      <div className="modal-box">
        {title && <h3 className="text-base font-semibold text-fg-bright">{title}</h3>}
        <p className={`py-2 text-sm whitespace-pre-wrap break-words text-fg-muted ${title ? "" : "pt-0"}`}>
          {message}
        </p>
        <div className="modal-action">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => ref.current?.close()}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn btn-xs ${danger ? "btn-error" : "btn-primary"}`}
            onClick={() => {
              confirmedRef.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
      {/* click outside the box closes (counts as cancel) */}
      <form method="dialog" className="modal-backdrop">
        <button type="submit" />
      </form>
    </dialog>
  );
}
