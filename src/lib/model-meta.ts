import { useApp } from "../store";
import type { HfModelInfo } from "../types";
import { hfModelInfo, saveSettings } from "./api";

/** Persist fetched repo info for a downloaded model (keyed by absolute path; sparse). */
async function saveModelMeta(path: string, meta: HfModelInfo): Promise<void> {
  const s = useApp.getState().settings;
  if (!s) return;
  const next = { ...s, model_meta: { ...(s.model_meta ?? {}), [path]: meta } };
  useApp.getState().setSettings(next);
  await saveSettings(next).catch(() => {});
}

/** Fetch + persist info for a repo once. Best-effort — failures leave the list on filename heuristics. */
export async function fetchAndSaveModelMeta(path: string, repoId: string): Promise<void> {
  try {
    const meta = await hfModelInfo(repoId);
    if (meta && meta.id) await saveModelMeta(path, meta);
  } catch {
    // offline / deleted repo — display falls back to filename heuristics
  }
}
