import { useEffect, useRef, useState } from "react";

export interface ComboOption {
  value: string;
  /** Secondary text shown after the value (e.g. a saved label). */
  hint?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  /** Classes for the input itself (width, daisyUI input sizing…). */
  className?: string;
}

/** Hand-rolled combobox — a free-typing input with a themed dropdown of suggestions.
 *  The native <datalist> popup can't be styled to match daisyUI, so this one is built
 *  from the app's own classes. Options are filtered by what's typed (substring,
 *  case-insensitive); picking one calls onChange with its value. */
export default function Combobox({ value, onChange, options, placeholder, className }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  const visible = options.filter((o) => !q || o.value.toLowerCase().includes(q));
  const idx = Math.min(active, Math.max(visible.length - 1, 0));

  // Close on outside click (not on blur — that would race the option's own click).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || visible.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(visible[idx].value);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => options.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={`${className ?? ""} ${options.length > 0 ? "pr-7" : ""}`}
      />
      {options.length > 0 && (
        <i
          className="fa-solid fa-chevron-down absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-fg-faint pointer-events-none"
          aria-hidden
        />
      )}
      {open && visible.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-60 overflow-y-auto rounded-md border border-line-strong bg-surface shadow-lg py-1">
          {visible.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input — no blur flicker
              onClick={() => pick(o.value)}
              className={`block w-full text-left px-2.5 py-1.5 text-xs ${
                i === idx ? "bg-hover text-fg-bright" : "text-fg hover:bg-hover"
              }`}
            >
              <span className="font-mono">{o.value}</span>
              {o.hint && <span className="ml-2 text-fg-muted">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
