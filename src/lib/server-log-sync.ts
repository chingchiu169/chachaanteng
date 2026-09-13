import { getServerLogs } from "./api";
import { useQl } from "../store-ql";

/**
 * Periodically reconcile each running tab's logs against the Rust ring buffer —
 * the source of truth for what the server has emitted. Live "server-log" events
 * are best-effort: start()'s `logs: []` wipe can eat lines that already arrived
 * (when launchServer resolves slowly), and a long model load leaves the terminal
 * quiet between bursts. Syncing from the ring keeps the terminal current within
 * one tick (2s) in either case, so the log area never sits blank while running.
 */
export function ensureLogSync() {
  // Window flag, not module scope: HMR re-runs App's mount effect with a fresh instance of this
  // file, and a module-level guard would start a SECOND interval (double getServerLogs IPC).
  const w = window as unknown as Record<string, unknown>;
  if (w.__logSyncStarted) return;
  w.__logSyncStarted = true;
  setInterval(() => {
    const st = useQl.getState();
    for (const x of st.tabs) {
      if (!x.running) continue;
      void getServerLogs(x.port)
        .then((ring) => {
          if (!ring.length) return;
          const cur = useQl.getState().tabs.find((t) => t.id === x.id);
          if (!cur || !cur.running) return;
          // tail comparison — cheap no-op check so steady state causes no re-renders
          if (cur.logs[cur.logs.length - 1] !== ring[ring.length - 1]) {
            useQl.getState().patchTab(x.id, { logs: ring.slice(-500) });
          }
        })
        .catch(() => {});
    }
  }, 2000);
}
