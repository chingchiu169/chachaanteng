import type { HfModelInfo } from "../types";
import { hfModelInfo } from "./api";
import { saveSettingsMerged } from "./settings-save";

/** Persist fetched repo info for a downloaded model (keyed by absolute path; sparse). */
async function saveModelMeta(path: string, meta: HfModelInfo): Promise<void> {
  // Merged at write time — the backfill effect fires one call per un-enriched model in a single
  // run, and a read-snapshot-then-full-save here would drop the earlier models' rows.
  await saveSettingsMerged((s) => ({ model_meta: { ...(s.model_meta ?? {}), [path]: meta } })).catch(() => {});
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
