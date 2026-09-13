import { listen } from "@tauri-apps/api/event";
import { useQl } from "../store-ql";

let started = false;

/**
 * Route server IPC events into the QL store for the whole app session. Views stay mounted
 * across tab switches, but routing must still outlive any single view instance (HMR remounts,
 * StrictMode double-mount) — a view-scoped listener would drop lines emitted in between; exit
 * toasts stay in QuickLaunchView because they're ephemeral UI.
 */
export function ensureServerEvents() {
  if (started) return;
  started = true;
  // In dev, HMR re-runs App's mount effect with a fresh module instance — bump the global
  // generation so listeners registered by previous instances become no-ops instead of
  // stacking (each stacked listener would append every line again).
  const w = window as unknown as Record<string, unknown>;
  w.__qlEvGen = ((w.__qlEvGen as number) ?? 0) + 1;
  const gen = w.__qlEvGen as number;
  void listen<{ port: number; line: string }>("server-log", (e) => {
    if ((w.__qlEvGen as number) !== gen) return; // stale HMR instance — a newer listener owns routing now
    useQl.getState().appendLog(e.payload.port, e.payload.line);
  });
  void listen<{ port: number; code: number | null }>("server-exited", (e) => {
    if ((w.__qlEvGen as number) !== gen) return;
    useQl.getState().markExited(e.payload.port, e.payload.code);
  });
}
