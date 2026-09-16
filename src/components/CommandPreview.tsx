import type { ReactNode } from "react";

/** Collapsible command preview shared by Quick Launch and Benchmarks: caret + title + warning-count badge, expandable body with the command text. */
export default function CommandPreview({
  open,
  onToggle,
  title,
  warnings = 0,
  extra,
  children,
  text,
  tall,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  /** Warning-count badge next to the title. */
  warnings?: number;
  /** Right side of the title row (e.g. a copy button) — visible without expanding. */
  extra?: ReactNode;
  /** Rendered above the command text when expanded (warning alerts, errors…). */
  children?: ReactNode;
  text: string;
  /** h-24 instead of h-20 for the command box. */
  tall?: boolean;
}) {
  return (
    <div className={`collapse shrink-0 rounded-none border-b border-line bg-surface ${open ? "collapse-open" : ""}`}>
      <div onClick={onToggle} className="collapse-title w-full px-3 py-2 flex items-center gap-1.5 select-none">
        <i
          className={`fa-solid fa-caret-right inline-block text-xs leading-none text-fg-faint transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="ml-1.5 text-xs font-medium text-fg-bright">{title}</span>
        {warnings > 0 && (
          <span className="badge badge-xs badge-soft badge-warning ml-2 align-middle">
            <i className="fa-solid fa-triangle-exclamation mr-1" aria-hidden />
            {warnings}
          </span>
        )}
        {extra}
      </div>
      {open && (
        <div className="collapse-content px-3 pb-2 space-y-2">
          {children}
          <pre
            className={`${tall ? "h-24" : "h-20"} overflow-y-auto px-3 py-2 rounded-md bg-base border border-line text-[11px] leading-relaxed text-fg-muted font-mono whitespace-pre-wrap break-all`}
          >
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
