import type { Settings } from "../types";
import { getSettings, saveSettings } from "./api";
import { useApp } from "../store";

/**
 * Serialized read-modify-write for the settings blob. Every writer (alias edits, model-delete
 * cleanup, engine installs, form Save…) goes through here: saves queue on one promise chain and
 * each re-reads at write time, so concurrent writers merge instead of last-write-wins clobbering
 * each other's fields. The store is updated with the merged value before the save resolves.
 */

// HMR-safe like every store in this codebase: Vite can serve several ?t= versions of this module
// in one page, and a plain module-level chain would then serialize per version — two live
// instances interleaving getSettings/saveSettings is exactly the race this module prevents.
const w = window as unknown as { __settingsSaveChain?: Promise<void> };

export function saveSettingsMerged(mutate: (s: Settings) => Partial<Settings>): Promise<void> {
  const run = (w.__settingsSaveChain ??= Promise.resolve()).then(async () => {
    const s = await getSettings();
    const next = { ...s, ...mutate(s) };
    useApp.getState().setSettings(next);
    await saveSettings(next);
  });
  // keep the chain alive even when a save fails — later writers must not be skipped
  w.__settingsSaveChain = run.catch(() => {});
  return run;
}
