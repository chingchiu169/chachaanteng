import { listServers, serverMetrics, serverProcessStats, serverProps, serverSlots } from "./api";
import { modelDisplayName } from "./model-aliases";
import { parsePrometheus } from "./prometheus";
import { useApp } from "../store";
import { useMonitor } from "../store-monitor";

const POLL_MS = 2000; // matches the Rust-side cache TTL — every tick gets a fresh sample

// Window singleton — same HMR rationale as bench-events.ts: under Vite ?t= fragmentation two live
// instances of this module can coexist. Whichever owns the interval keeps polling, but MonitorView's
// manual Refresh may call refreshServers from a second instance — it must share the baselines and
// the in-flight guard or it would poll with empty baselines (one null tok/s sample) and double-poll.
interface MonitorSyncState {
  /** Counter baselines for tok/s deltas, keyed by port. */
  prevCounters: Map<number, { promptN?: number; predN?: number; t: number }>;
  /** Active-time accumulators for the average tiles, keyed by port: tokens moved since this
   *  monitoring session + seconds a slot was actually processing at sample time. Reset when the
   *  server's counters regress (restart) or the server disappears. */
  activeAcc: Map<number, { activeMs: number; promptTokens: number; predTokens: number }>;
  /** A slow tick must not overlap the next one. */
  refreshing: boolean;
}

const w = window as unknown as { __monSyncState?: MonitorSyncState };
const st: MonitorSyncState = (w.__monSyncState ??= {
  prevCounters: new Map(),
  activeAcc: new Map(),
  refreshing: false,
});

/** One poll cycle: refresh every running server's /metrics + /slots + /props and fold the
 *  counter deltas into the store. Exported so MonitorView's manual Refresh button can force
 *  an immediate cycle (the interval keeps its own cadence regardless). */
export async function refreshServers() {
  if (st.refreshing) return;
  st.refreshing = true;
  try {
    let list: { port: number; model_path: string }[] = [];
    try {
      list = await listServers();
    } catch {
      return;
    }
    const setServers = useMonitor.getState().setServers;
    // Display aliases are read once per tick — an alias change shows up within one poll.
    const aliases = useApp.getState().settings?.model_aliases;
    // Stable card order — list_servers comes from a Rust HashMap whose iteration reshuffles on
    // insert/remove, which would swap the panels' positions after any server start/stop.
    list.sort((a, b) => a.port - b.port);
    // Drop baselines + accumulators for servers that are gone.
    const livePorts = new Set(list.map((s) => s.port));
    for (const port of [...st.prevCounters.keys()]) {
      if (!livePorts.has(port)) st.prevCounters.delete(port);
    }
    for (const port of [...st.activeAcc.keys()]) {
      if (!livePorts.has(port)) st.activeAcc.delete(port);
    }
    // Merge with the previous state — existing panels keep their last data while refetching
    // (busy flag only), so nothing flickers and expanded sections stay open. Only brand-new
    // ports start empty; servers that disappeared are dropped.
    setServers((prev) => {
      const byPort = new Map(prev.map((p) => [p.port, p]));
      return list.map((s) => {
        const old = byPort.get(s.port);
        if (old) return { ...old, busy: true };
        return {
          port: s.port,
          model: modelDisplayName(s.model_path, aliases, s.model_path.split(/[\\/]/).pop()),
          metrics: null,
          slots: null,
          props: null,
          error: null,
          busy: true,
          history: [],
          promptTotal: null,
          predTotal: null,
          promptAvgTokS: null,
          predAvgTokS: null,
          cpuPercent: null,
          ramBytes: 0,
          gpuUtilPercent: null,
          gpuMemBytes: null,
        };
      });
    });
    // Fetch all servers in parallel — one wedged server (5 s timeout per endpoint) must not
    // stall the panels behind it. The `refreshing` guard already keeps ticks from overlapping,
    // and each closure touches only its own port's baseline + store entry.
    await Promise.all(
      list.map(async (entry) => {
        try {
          // Process telemetry is best-effort — a failure here (e.g. the PID just died) must not
          // mark the panel errored, so it's caught separately and degrades to nulls.
          const [metrics, slots, props, proc] = await Promise.all([
            serverMetrics(entry.port),
            serverSlots(entry.port),
            serverProps(entry.port),
            serverProcessStats(entry.port).catch(() => null),
          ]);
          // tok/s = counter delta between polls. A negative delta (server restarted) or a stale
          // gap (>60s — e.g. the app was closed in between) yields null for that sample; the
          // baseline is always refreshed so the next tick recovers.
          const m = parsePrometheus(metrics);
          // b10864+ renamed the metrics to llamacpp:*; older builds use llama_*_n — accept both.
          // Prompt counts include cached tokens so chat follow-ups (mostly cache hits) still show activity.
          const promptN =
            m["llamacpp:prompt_tokens_total"] !== undefined
              ? m["llamacpp:prompt_tokens_total"] + (m["llamacpp:prompt_tokens_cached_total"] ?? 0)
              : m.llama_prompt_n;
          const predN = m["llamacpp:tokens_predicted_total"] ?? m.llama_prediction_n;
          const now = Date.now();
          let promptTokS: number | null = null;
          let genTokS: number | null = null;
          // undefined (not null) when this tick can't measure — then the previous averages are kept.
          let promptAvgTokS: number | null | undefined;
          let predAvgTokS: number | null | undefined;
          const base = st.prevCounters.get(entry.port) ?? { t: 0 };
          const dt = (now - base.t) / 1000;
          if (dt > 0 && dt < 60) {
            let dPrompt = 0; // raw token deltas this tick — feed the active-time averages
            let dPred = 0;
            if (promptN !== undefined && base.promptN !== undefined) {
              if (promptN >= base.promptN) {
                dPrompt = promptN - base.promptN;
                promptTokS = dPrompt / dt;
              } else st.activeAcc.delete(entry.port); // counter regressed — server restarted, restart the averages too
            }
            if (predN !== undefined && base.predN !== undefined) {
              if (predN >= base.predN) {
                dPred = predN - base.predN;
                genTokS = dPred / dt;
              } else st.activeAcc.delete(entry.port);
            }
            // Active time: seconds a slot was actually processing at sample time — idle gaps
            // between requests must not dilute the average. b10864+ slots carry is_processing
            // (no `state` string); older builds use state !== "idle".
            const slotArr = Array.isArray(slots) ? (slots as { state?: string; is_processing?: boolean }[]) : [];
            const processing = slotArr.some((x) => (x.is_processing !== undefined ? x.is_processing === true : (x.state ?? "") !== "idle"));
            const acc = st.activeAcc.get(entry.port) ?? { activeMs: 0, promptTokens: 0, predTokens: 0 };
            if (processing) acc.activeMs += dt * 1000;
            acc.promptTokens += dPrompt;
            acc.predTokens += dPred;
            st.activeAcc.set(entry.port, acc);
            if (acc.activeMs > 0) {
              promptAvgTokS = acc.promptTokens / (acc.activeMs / 1000);
              predAvgTokS = acc.predTokens / (acc.activeMs / 1000);
            }
          }
          if (promptN !== undefined || predN !== undefined) {
            st.prevCounters.set(entry.port, { promptN, predN, t: now });
          }
          setServers((prev) =>
            prev.map((p) =>
              p.port === entry.port
                ? { ...p, model: modelDisplayName(entry.model_path, aliases, entry.model_path.split(/[\\/]/).pop()), metrics, slots, props, error: null, busy: false, promptTotal: promptN ?? null, predTotal: predN ?? null, ...(promptAvgTokS !== undefined ? { promptAvgTokS, predAvgTokS } : {}), ...(proc ? { cpuPercent: proc.cpu_percent, ramBytes: proc.ram_bytes, gpuUtilPercent: proc.gpu_util_percent, gpuMemBytes: proc.gpu_mem_bytes } : {}), history: [...p.history.slice(-59), { t: now, promptTokS, genTokS }] }
                : p,
            ),
          );
        } catch (e) {
          setServers((prev) => prev.map((p) => (p.port === entry.port ? { ...p, error: String(e), busy: false } : p)));
        }
      }),
    );
  } finally {
    st.refreshing = false;
  }
}

/** Start the app-lifetime poll (once). Called from App's mount effect.
 *
 * The once-guard lives on window rather than module scope: in dev, HMR re-runs App's mount
 * effect with a fresh module instance of this file, and a module-level flag would start a
 * SECOND interval — double polling. A window flag survives module reloads; the shared state
 * (window singleton above) keeps every instance reading/writing the same baselines + guard. */
export function ensureMonitorSync() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__monSyncStarted) return;
  w.__monSyncStarted = true;
  void refreshServers();
  setInterval(() => {
    void refreshServers();
  }, POLL_MS);
}
