import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { setModelAlias } from "../lib/model-aliases";
import { inputCls } from "../lib/ui";

/**
 * Editable display alias for a model path — the value lives in settings.model_aliases, so this
 * is just a commit-on-blur/Enter editor over it (Escape reverts). Re-syncs when the stored value
 * changes externally (delete cleanup, another cell editing the same path).
 */
export default function ModelAliasInput({ path, disabled = false, className = "" }: { path: string; disabled?: boolean; className?: string }) {
  const stored = useApp((s) => s.settings?.model_aliases?.[path] ?? "");
  const [draft, setDraft] = useState(stored);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(stored);
  }, [stored, focused]);

  // The component instance survives QL tab switches (same position in the tree), so `draft` can
  // still hold the PREVIOUS model's text when `path` changes — committing that would write an
  // alias for the wrong model. A path change is a different field: reset even while focused.
  const prevPath = useRef(path);
  useEffect(() => {
    if (prevPath.current !== path) {
      prevPath.current = path;
      setDraft(stored);
    }
  }, [path, stored]);

  const commit = () => {
    setFocused(false);
    if (draft.trim() !== stored) void setModelAlias(path, draft);
  };

  return (
    <input
      value={draft}
      disabled={disabled || !path}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          setDraft(stored);
          setFocused(false);
        }
      }}
      className={`${inputCls} ${className || "w-full"}`}
    />
  );
}
