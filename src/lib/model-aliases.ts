import { useApp } from "../store";
import { saveSettings } from "./api";

/** Alias lookup tolerant of separator style (keys are absolute paths; adopted orphans may differ). */
function lookupAlias(aliases: Record<string, string> | null | undefined, path: string): string | undefined {
  const exact = aliases?.[path];
  if (exact !== undefined) return exact;
  const norm = path.replace(/\\/g, "/");
  for (const [k, v] of Object.entries(aliases ?? {})) {
    if (k.replace(/\\/g, "/") === norm) return v;
  }
  return undefined;
}

/**
 * Display name for a model path: the user-set alias when present, else `fallback` — each call
 * site passes its own current derivation so existing behavior is preserved exactly — else the
 * basename with .gguf stripped.
 */
export function modelDisplayName(
  path: string | null | undefined,
  aliases?: Record<string, string> | null,
  fallback?: string,
): string {
  if (path) {
    const alias = lookupAlias(aliases, path)?.trim();
    if (alias) return alias;
  }
  if (fallback) return fallback;
  return ((path ?? "").split(/[\\/]/).pop() ?? "").replace(/\.gguf$/i, "");
}

/** Set or clear the display alias for a model path. Empty string clears it (keeps the map sparse). */
export async function setModelAlias(path: string, alias: string): Promise<void> {
  const s = useApp.getState().settings;
  if (!s) return;
  const aliases = { ...(s.model_aliases ?? {}) };
  const trimmed = alias.trim();
  if (trimmed) aliases[path] = trimmed;
  else delete aliases[path];
  const next = { ...s, model_aliases: aliases };
  useApp.getState().setSettings(next);
  await saveSettings(next).catch(() => {});
}
