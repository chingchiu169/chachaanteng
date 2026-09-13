import { create } from "zustand";
import type { ServerJsonValue } from "./lib/api";

/** One tok/s sample per poll tick — the sparkline's data. Nulls mark gaps (first sample,
 *  counter reset, stale gap) and split a series into separate runs. */
export interface Sample {
  t: number;
  promptTokS: number | null;
  genTokS: number | null;
}

/** Per-server live telemetry panel. Owned by the app-lifetime poller (lib/monitor-sync.ts),
 *  NOT any view — rates + history keep accumulating while the user is on other pages, so
 *  opening Monitor shows what actually happened, not just what happened since arrival. */
export interface ServerPanel {
  port: number;
  model: string;
  metrics: string | null;
  slots: ServerJsonValue | null;
  props: ServerJsonValue | null;
  error: string | null;
  busy: boolean;
  history: Sample[];
  /** Cumulative /metrics counters (server-lifetime totals — reset when the server restarts).
   *  Same values the tok/s deltas are computed from, kept for the "total" tiles. */
  promptTotal: number | null;
  predTotal: number | null;
  /** Average t/s over ACTIVE time only — tokens moved since this monitoring session divided by
   *  seconds a slot was actually processing (idle gaps don't dilute it). Null until the server
   *  has been observed busy at least once. */
  promptAvgTokS: number | null;
  predAvgTokS: number | null;
  /** Per-process CPU busy % across all logical processors (Rust FFI); null on the first sample —
   *  no baseline yet for the delta. */
  cpuPercent: number | null;
  /** Working-set RAM in bytes; 0 when it can't be read. */
  ramBytes: number;
  /** Per-process GPU SM utilization % (nvidia-smi pmon); null without NVIDIA / not a compute app. */
  gpuUtilPercent: number | null;
  /** Per-process VRAM in bytes; null without NVIDIA / not a compute app. */
  gpuMemBytes: number | null;
}

interface MonitorState {
  servers: ServerPanel[];
  /** Expanded raw-data sections keyed `${port}:metrics|slots|props` — in the store (not view
   *  state) so they survive page switches, same as the data they reveal. */
  openPanels: Record<string, boolean>;
  setServers: (fn: (prev: ServerPanel[]) => ServerPanel[]) => void;
  togglePanel: (id: string) => void;
}

function makeMonitorStore() {
  return create<MonitorState>((set) => ({
    servers: [],
    openPanels: {},
    setServers: (fn) => set((s) => ({ servers: fn(s.servers) })),
    togglePanel: (id) => set((s) => ({ openPanels: { ...s.openPanels, [id]: !s.openPanels[id] } })),
  }));
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
const w = window as unknown as { __monitorStore?: ReturnType<typeof makeMonitorStore> };
export const useMonitor: ReturnType<typeof makeMonitorStore> = (w.__monitorStore ??= makeMonitorStore());
