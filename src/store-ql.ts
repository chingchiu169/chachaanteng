import { create } from "zustand";
import type { FlagValues } from "./flags/types";
import { getServerLogs, listServers } from "./lib/api";
import { effectiveFor, useScopes } from "./store-scopes";
import { useFlags } from "./store-flags";

/** One server session — each tab owns its engine/port/model/flags/logs. */
export interface QlTab {
  id: string;
  engineExe: string;
  port: number;
  model: string;
  /** effective flag values (defaults merged) for this tab's working set */
  values: FlagValues;
  running: boolean;
  healthy: boolean;
  /** server outlived an app restart — re-adopted, so its live output can't be captured */
  reconnected: boolean;
  logs: string[];
  lastExitCode: number | null;
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
// The tab-id counter lives here too so hot updates can't restart it and mint duplicate ids.
const w = window as unknown as { __qlStore?: ReturnType<typeof makeQlStore>; __qlTabSeq?: number };

const newTabId = () => `ql-${(w.__qlTabSeq = (w.__qlTabSeq ?? 0) + 1)}-${Date.now().toString(36)}`;

/** Idle-tab factory — shared by init() and addIdleTab(). */
function makeIdleTab(engineExe: string, port: number, model: string): QlTab {
  const scopes = useScopes.getState();
  return {
    id: newTabId(),
    engineExe,
    port,
    model,
    values: effectiveFor(scopes.global, scopes.overrides, model),
    running: false,
    healthy: false,
    reconnected: false,
    logs: [],
    lastExitCode: null,
  };
}

/** First free port at or after basePort. */
function nextFreePort(tabs: QlTab[], basePort: number): number {
  let p = basePort;
  while (tabs.some((x) => x.port === p)) p++;
  return p;
}

interface QlState {
  tabs: QlTab[];
  activeId: string;
  /** true once the initial tab set has been built — survives HMR remounts (window-singleton store) */
  initialized: boolean;

  /** Build the initial tab set once per app session (running servers + one idle). */
  init: (engineExe: string, basePort: number) => Promise<void>;
  /** @param defaultModel optional model preselected for the new tab (settings.default_model). */
  addIdleTab: (engineExe: string, basePort: number, defaultModel?: string) => void;
  patchTab: (id: string, patch: Partial<QlTab>) => void;
  removeTab: (id: string) => void;
  setActiveId: (id: string) => void;
  appendLog: (port: number, line: string) => void;
  markExited: (port: number, code: number | null) => void;
  setHealthy: (port: number, ok: boolean) => void;
  /** Mark running tabs whose port no longer has a live server as exited. */
  reconcile: (runningPorts: Set<number>) => void;
  /** Clear a model path from every tab after its file was deleted elsewhere — running tabs included,
   *  so a deleted model is never offered in the dropdown again (the server keeps serving; the OS holds
   *  the open handle). Must be paired with clearing store-flags' global model in the same synchronous
   *  block: QuickLaunchView's adopt effect re-injects any non-empty global model into the active idle
   *  tab, so a stale global resurrects the path one render later. */
  clearModel: (path: string) => void;
}

function makeQlStore() {
  return create<QlState>((set, get) => ({
    tabs: [],
    activeId: "",
    initialized: false,

    init: async (engineExe, basePort) => {
      if (get().initialized) return;
      const scopes = useScopes.getState();
      let list: { port: number; model_path: string; reconnected?: boolean }[] = [];
      try {
        list = await listServers();
      } catch {
        /* app not ready */
      }
      if (get().initialized) return; // a concurrent re-init won the race — don't clobber later state
      const built: QlTab[] = [];
      for (const s of list) {
        let logs: string[] = [];
        try {
          // pull the full ring buffer so no lines are lost across tab switches
          logs = (await getServerLogs(s.port)).slice(-500);
        } catch {
          /* non-fatal */
        }
        built.push({
          id: newTabId(),
          engineExe,
          port: s.port,
          model: s.model_path,
          values: effectiveFor(scopes.global, scopes.overrides, s.model_path),
          running: true,
          healthy: false,
          reconnected: s.reconnected === true,
          logs,
          lastExitCode: null,
        });
      }
      // No running servers found → seed one idle tab.
      if (built.length === 0) {
        const storeM = useFlags.getState().model;
        built.push(makeIdleTab(engineExe, nextFreePort(built, basePort), storeM));
      }
      // Merge with any tabs created while we were listing (user hit "add" mid-init) so a slow
      // listServers() can't clobber them.
      const extra = get().tabs.filter((t) => !built.some((b) => b.port === t.port));
      set({ tabs: [...built, ...extra], activeId: built[0]?.id ?? extra[0]?.id ?? "", initialized: true });
    },

    addIdleTab: (engineExe, basePort, defaultModel) => {
      const tab = makeIdleTab(engineExe, nextFreePort(get().tabs, basePort), defaultModel ?? "");
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },

    patchTab: (id, patch) =>
      set((s) => ({ tabs: s.tabs.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),

    removeTab: (id) =>
      set((s) => {
        const idx = s.tabs.findIndex((x) => x.id === id);
        if (idx < 0) return s;
        const tabs = s.tabs.filter((x) => x.id !== id);
        let activeId = s.activeId;
        if (activeId === id) {
          const next = tabs[idx] ?? tabs[idx - 1];
          activeId = next ? next.id : "";
        }
        return { tabs, activeId };
      }),

    setActiveId: (id) => set({ activeId: id }),

    appendLog: (port, line) => {
      // No live tab for this port — skip the set so a dead server's log stream can't churn refs.
      if (!get().tabs.some((x) => x.port === port)) return;
      set((s) => ({
        tabs: s.tabs.map((x) => (x.port === port ? { ...x, logs: [...x.logs.slice(-499), line] } : x)),
      }));
    },

    markExited: (port, code) => {
      const s = get();
      if (!s.tabs.some((x) => x.port === port && (x.running || x.lastExitCode !== code))) return;
      set({
        tabs: s.tabs.map((x) => (x.port === port ? { ...x, running: false, lastExitCode: code } : x)),
      });
    },

    setHealthy: (port, ok) => {
      // Health polls every 3 s per running port — skip the set when nothing actually changed.
      const s = get();
      if (!s.tabs.some((x) => x.port === port && x.healthy !== ok)) return;
      set({ tabs: s.tabs.map((x) => (x.port === port ? { ...x, healthy: ok } : x)) });
    },

    reconcile: (runningPorts) => {
      if (!get().initialized) return;
      const stale = get().tabs.some((x) => x.running && !runningPorts.has(x.port));
      if (!stale) return;
      set((s) => ({
        tabs: s.tabs.map((x) => (x.running && !runningPorts.has(x.port) ? { ...x, running: false } : x)),
      }));
    },

    clearModel: (path) => {
      const s = get();
      if (!s.tabs.some((t) => t.model === path)) return;
      const scopes = useScopes.getState();
      set({
        tabs: s.tabs.map((t) =>
          t.model === path
            ? { ...t, model: "", values: effectiveFor(scopes.global, scopes.overrides, "") }
            : t,
        ),
      });
    },
  }));
}

export const useQl: ReturnType<typeof makeQlStore> = (w.__qlStore ??= makeQlStore());
