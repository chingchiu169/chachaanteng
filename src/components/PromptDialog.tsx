import { FormEvent, useEffect, useRef, useState } from "react";

interface Props {
  open: boolean;
  title?: string;
  placeholder?: string;
  /** Prefilled value (e.g. the current name when renaming). */
  initial?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Receives the trimmed, non-empty value; the parent closes by setting `open` to false. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Text-entry dialog — daisyUI Modal, Method 1 (native `<dialog class="modal">`).
 * Replaces window.prompt, which the Tauri webview suppresses.
 */
export default function PromptDialog({
  open,
  title,
  placeholder,
  initial = "",
  submitLabel = "OK",
  cancelLabel = "Cancel",
  onSubmit,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  /** Tracks the shown state ourselves — StrictMode double-invokes effects. */
  const shownRef = useRef(false);
  /** Set when submitted so the resulting close event doesn't also fire onCancel. */
  const confirmedRef = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !shownRef.current) {
      confirmedRef.current = false;
      setValue(initial);
      shownRef.current = true;
      d.showModal();
      // focus + select once the dialog is in the top layer
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else if (!open && shownRef.current) {
      shownRef.current = false;
      d.close();
    }
  }, [open, initial]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    confirmedRef.current = true;
    onSubmit(v);
  };

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
        <form onSubmit={submit}>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className={`input border border-line-strong text-fg w-full ${title ? "mt-3" : ""}`}
          />
          <div className="modal-action">
            <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
              {cancelLabel}
            </button>
            <button type="submit" disabled={!value.trim()} className="btn btn-sm btn-primary">
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
      {/* click outside the box closes (counts as cancel) */}
      <form method="dialog" className="modal-backdrop">
        <button type="submit" />
      </form>
    </dialog>
  );
}
