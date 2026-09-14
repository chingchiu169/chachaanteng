import { useEffect, useState, type ReactNode } from "react";
import { getSystemStats, type SystemStats } from "../lib/api";
import { useT } from "../i18n";
import { useApp } from "../store";
import { useMonitor, type Sample } from "../store-monitor";
import { refreshServers } from "../lib/monitor-sync";
import { fmtClock } from "../lib/time";
import { parsePrometheus } from "../lib/prometheus";
import { isMac } from "../lib/platform";
import { ghostBtn } from "../lib/ui";

const POLL_MS = 2000; // matches the Rust-side cache TTL — every tick gets a fresh sample (system stats only)

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function fmtRate(bps: number): string {
  const mb = bps / (1024 ** 2);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

/** tok/s for tiles — whole numbers are plenty at this scale; "—" until a rate exists. */
function fmtTok(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}`;
}

/** Cumulative token counters — grouped digits so millions stay readable; "—" until first sample. */
function fmtCount(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : Math.round(v).toLocaleString();
}

/** Fill color by load — app palette tokens (theme-aware), same hues as daisyUI's progress-*. */
function barVariant(pct: number): string {
  if (pct >= 85) return "bg-red";
  if (pct >= 60) return "bg-yellow";
  return "bg-green";
}

// WKWebView renders <progress> at its ~24px UA height and ignores daisyUI's .progress height
// rule, so every bar in this view is a hand-rolled div — one shared track class keeps the rows
// pixel-identical (8px tall).
const TRACK_CLS = "flex h-2 w-full rounded-full bg-[color-mix(in_oklab,var(--color-base-content)_20%,transparent)]";

function Bar({ label, used, total, extra, segments, valueText }: {
  label: string;
  used: number | null;
  total: number;
  extra?: ReactNode;
  /** Stacked colored fill (the RAM breakdown) — replaces the single-color progress when non-empty. */
  segments?: { value: number; cls: string; title?: string }[];
  /** Right-hand readout override (CPU shows a %, not bytes). */
  valueText?: string;
}) {
  const pct = used !== null && total > 0 ? Math.min(100, (used / total) * 100) : null;
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center gap-2 text-xs">
        <span className="text-fg-muted flex items-center gap-2 min-w-0">{label}{extra}</span>
        <span className="font-mono text-fg-bright shrink-0">
          {valueText ?? (pct === null ? "—" : `${fmtBytes(used ?? 0)} / ${fmtBytes(total)} (${pct.toFixed(0)}%)`)}
        </span>
      </div>
      {segments && segments.length > 0 ? (
        // daisyUI tooltips are ::before/::after on the segment itself, so no overflow:hidden
        // here — end segments carry the corner rounding instead.
        <div className={TRACK_CLS}>
          {segments.map((s, i) => (
            <div
              key={i}
              data-tip={s.title ? `${s.title}: ${fmtBytes(s.value)}` : fmtBytes(s.value)}
              className={`tooltip ${s.cls} h-full ${i === 0 ? "rounded-l-full" : ""} ${i === segments.length - 1 ? "rounded-r-full" : ""}`}
              style={{ width: `${Math.min(100, (s.value / total) * 100)}%` }}
            />
          ))}
        </div>
      ) : (
        <div className={TRACK_CLS}>
          {pct !== null && (
            <div className={`${barVariant(pct)} h-full rounded-full`} style={{ width: `${pct}%` }} />
          )}
        </div>
      )}
    </div>
  );
}

/** Controlled collapsible — unlike native <details>, its open state survives re-renders. */
function Section({
  id,
  open,
  onToggle,
  label,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: (id: string) => void;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <button onClick={() => onToggle(id)} className="text-[11px] text-fg-muted cursor-pointer flex items-center gap-1">
        <i className={`fa-solid fa-caret-right inline-block text-[10px] leading-none transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        {label}
      </button>
      {open && children}
    </div>
  );
}

/** Compact at-a-glance tile — label on top, mono value below. */
function StatTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="bg-elevated rounded px-2 py-1" title={title}>
      <div className="text-[10px] text-fg-muted">{label}</div>
      <div className="font-mono text-xs text-fg-bright">{value}</div>
    </div>
  );
}

/** Hand-rolled SVG sparkline (no chart library). Nulls split a series into separate runs;
 *  vector-effect keeps strokes uniform despite preserveAspectRatio="none". */
function Sparkline({ samples }: { samples: Sample[] }) {
  const n = samples.length;
  if (n < 2) return <div className="h-12 flex items-center justify-center text-xs text-fg-faint">—</div>;
  const all = [...samples.map((s) => s.promptTokS), ...samples.map((s) => s.genTokS)].filter(
    (v): v is number => v !== null,
  );
  const max = Math.max(1, ...all);
  const x = (i: number) => (i / (n - 1)) * 100;
  const y = (v: number) => 23 - (v / max) * 21;
  const runs = (get: (s: Sample) => number | null): string[] => {
    const out: string[] = [];
    let cur: string[] = [];
    samples.forEach((s, i) => {
      const v = get(s);
      if (v === null) {
        if (cur.length > 1) out.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
      }
    });
    if (cur.length > 1) out.push(cur.join(" "));
    return out;
  };
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="w-full h-12">
      <line x1={0} y1={23.5} x2={100} y2={23.5} strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-line-strong" />
      {runs((s) => s.promptTokS).map((pts, i) => (
        <polyline key={`p${i}`} points={pts} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-cyan" />
      ))}
      {runs((s) => s.genTokS).map((pts, i) => (
        <polyline key={`g${i}`} points={pts} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-green" />
      ))}
    </svg>
  );
}

function slotChipCls(state?: string): string {
  if (state === "generating") return "border-green text-green";
  if (state === "processing-prompt") return "border-cyan text-cyan";
  return "border-line-strong text-fg-muted";
}

export default function MonitorView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const { settings } = useApp();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [lastError, setLastError] = useState("");
  // Server telemetry is polled app-lifetime (lib/monitor-sync.ts) so tok/s rates + sparkline
  // history keep accumulating on other pages; this view just renders the store.
  const servers = useMonitor((s) => s.servers);
  const openPanels = useMonitor((s) => s.openPanels);
  const togglePanel = useMonitor((s) => s.togglePanel);

  // FR6.1/FR6.2 — poll system + GPU telemetry every 2s (Rust cache dedupes). Gated on `visible`
  // (the view stays mounted on other tabs); the immediate tick below gives a fresh sample the
  // moment the page is shown again. Server tok/s data is app-lifetime (lib/monitor-sync.ts) and
  // keeps accumulating regardless.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getSystemStats(false);
        if (alive) {
          setStats(s);
          setLastError("");
        }
      } catch (e) {
        if (alive) setLastError(String(e));
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [visible]);

  /** FR6.1 — bypass the cache for an immediate fresh sample. */
  const recheck = async () => {
    try {
      setStats(await getSystemStats(true));
      setLastError("");
    } catch (e) {
      setLastError(String(e));
    }
  };

  // macOS Activity-Monitor-style RAM breakdown — same counters AM reads (vm_stat/swapusage).
  // Each part carries the color of its bar segment; the dots in the label row double as the legend.
  // Windows reports nulls, so nothing renders there and the plain progress bar stays.
  const ramParts = isMac() && stats
    ? ([
        [t("mon.ramApp"), "bg-accent", stats.ram_app_bytes],
        [t("mon.ramWired"), "bg-cyan", stats.ram_wired_bytes],
        [t("mon.ramCompressed"), "bg-yellow", stats.ram_compressed_bytes],
      ] as [string, string, number | null][])
        .filter((p): p is [string, string, number] => (p[2] ?? 0) > 0)
    : [];

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* system */}
      <div className="p-3 border-b border-line bg-surface space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-bright">{t("mon.system")}</span>
          {stats && (
            <span className="text-[11px] text-fg-faint">
              {t("mon.sampledAt", { time: fmtClock(stats.sampled_at_ms, settings?.use_24h) })}
            </span>
          )}
          <button onClick={recheck} className={`${ghostBtn} ml-auto`}>
            {t("mon.recheck")}
          </button>
        </div>
        {lastError && (
          <div role="alert" className="alert alert-error">
            {lastError}
          </div>
        )}
        {!stats ? (
          <div className="text-xs text-fg-faint">{t("mon.readingStats")}</div>
        ) : (
          <>
            {/* All three system rows go through Bar — identical DOM, so the heights can't drift. */}
            <Bar
              label="CPU"
              used={stats.cpu_percent}
              total={100}
              valueText={stats.cpu_percent !== null ? `${stats.cpu_percent.toFixed(1)}%` : t("mon.firstSample")}
            />
            {/* RAM — on macOS the label row carries the breakdown (dots = bar-segment legend, like the
                disk throughput arrows) and the bar itself is stacked per category. */}
            <Bar
              label="RAM"
              used={stats.ram_used_bytes}
              total={stats.ram_total_bytes}
              segments={ramParts.length > 0 ? ramParts.map(([label, cls, v]) => ({ value: v, cls, title: label })) : undefined}
              extra={
                ramParts.length > 0 || stats.swap_used_bytes !== null ? (
                  <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-fg-muted">
                    {ramParts.map(([label, cls, v]) => (
                      <span key={label} className="tooltip" data-tip={label}>
                        <span className={`inline-block w-2 h-2 rounded-full mr-1 align-middle ${cls}`} />{fmtBytes(v)}
                      </span>
                    ))}
                    {stats.swap_used_bytes !== null && stats.swap_used_bytes > 0 && (
                      <span className="tooltip" data-tip={t("mon.swapUsed")}>
                        <i className="fa-solid fa-right-left mr-1" aria-hidden />{fmtBytes(stats.swap_used_bytes)}
                      </span>
                    )}
                  </span>
                ) : undefined
              }
            />
            {/* Whole-system disk throughput (PDH rate counters) — inline after the label, always rendered
                ("—" until the first valid sample) so nothing shifts when values arrive. */}
            <Bar
              label={t("mon.diskLabel")}
              used={stats.disk_used_bytes}
              total={stats.disk_total_bytes}
              extra={
                <span className="flex gap-2 font-mono text-[11px] text-fg-muted">
                  {/* daisyUI tooltip — label only, the rate itself is already shown inline */}
                  <span className="tooltip" data-tip={t("mon.diskRead")}>
                    <i className="fa-solid fa-arrow-up mr-1" aria-hidden />{stats.disk_read_bps !== null ? fmtRate(stats.disk_read_bps) : "—"}
                  </span>
                  <span className="tooltip" data-tip={t("mon.diskWrite")}>
                    <i className="fa-solid fa-arrow-down mr-1" aria-hidden />{stats.disk_write_bps !== null ? fmtRate(stats.disk_write_bps) : "—"}
                  </span>
                </span>
              }
            />
          </>
        )}
      </div>

      {!isMac() && (
      /* GPU — hidden on macOS (no Apple-GPU telemetry in v1) */
      <div className="p-3 border-b border-line bg-surface space-y-2">
        <span className="text-xs font-medium text-fg-bright">{t("mon.gpuTitle")}</span>
        {!stats || stats.gpus.length === 0 ? (
          <div className="text-xs text-fg-faint">{t("mon.noGpu")}</div>
        ) : (
          <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {stats.gpus.map((g, i) => (
              <div key={i} className="card card-border bg-raised p-2 space-y-1.5">
                <div className="text-xs font-medium text-green truncate" title={g.name}>{g.name}</div>
                {g.utilization_percent !== null && (
                  <>
                    <div className="flex justify-between text-[11px] text-fg-muted">
                      <span>{t("mon.utilization")}</span>
                      <span className="font-mono">{g.utilization_percent.toFixed(0)}%</span>
                    </div>
                    <div className={TRACK_CLS}>
                      <div
                        className={`${barVariant(Math.min(100, g.utilization_percent))} h-full rounded-full`}
                        style={{ width: `${Math.min(100, g.utilization_percent)}%` }}
                      />
                    </div>
                  </>
                )}
                {g.memory_total_bytes !== null && (
                  <div className="flex justify-between text-[11px] text-fg-muted">
                    <span>VRAM</span>
                    <span className="font-mono">{fmtBytes(g.memory_used_bytes ?? 0)} / {fmtBytes(g.memory_total_bytes)}</span>
                  </div>
                )}
                <div className="flex gap-3 text-[11px] text-fg-muted">
                  {g.temperature_c !== null && (
                    <span><i className="fa-solid fa-temperature-half mr-1" aria-hidden />{g.temperature_c.toFixed(0)}°C</span>
                  )}
                  {g.power_watts !== null && (
                    <span><i className="fa-solid fa-bolt mr-1" aria-hidden />{g.power_watts.toFixed(0)} W</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* FR6.3 — live server metrics */}
      <div className="p-3 border-b border-line bg-surface space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-bright">{t("mon.serverMetrics")}</span>
          <button onClick={refreshServers} className={ghostBtn}>
            {t("common.refresh")}
          </button>
        </div>
        {servers.length === 0 ? (
          <div className="text-xs text-fg-faint">{t("mon.noServers")}</div>
        ) : (
          servers.map((s) => {
            // Derived from the same data the raw panels below show — re-parsing a few KB of
            // text per render is negligible at this size.
            const m = s.metrics !== null ? parsePrometheus(s.metrics) : {};
            const last = s.history[s.history.length - 1];
            const totalSlots = typeof s.props?.total_slots === "number" ? s.props.total_slots : null;
            // b10864+ lists every slot with an is_processing flag (no `state` string); older builds
            // only listed active slots with state: idle|processing-prompt|generating.
            const slotList = Array.isArray(s.slots)
              ? (s.slots as { id?: number | string; state?: string; is_processing?: boolean }[])
              : [];
            // Prefer is_processing when present — on b10864+ the `state` field is absent, so the
            // state fallback alone ("") would count EVERY idle slot as busy.
            const busySlots = s.slots !== null ? slotList.filter((x) => (x.is_processing !== undefined ? x.is_processing === true : (x.state ?? "") !== "idle")) : null;
            // Queue: b10864+ exposes requests_deferred; older builds expose llama_server_n_queue.
            const queue = m["llamacpp:requests_deferred"] ?? m.llama_server_n_queue;
            return (
            <div key={s.port} className="card card-border bg-raised p-2 space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-green">port {s.port}</span>
                <span className="text-fg-muted truncate" title={s.model}>{s.model}</span>
                {/* Only while the panel has no data yet (first fetch after a server starts) — every 2 s
                    poll tick sets busy, so keying on it alone would pulse "loading" forever. */}
                {s.busy && s.metrics === null && <span className="text-[11px] text-fg-faint animate-pulse">{t("mon.fetching")}</span>}
              </div>
              {s.error && (
                <div role="alert" className="alert alert-error">
                  {s.error}
                </div>
              )}
              {/* At-a-glance view of the raw panels below — live rates, queue, slots + 2-min throughput. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                <StatTile label={t("mon.promptTokS")} value={fmtTok(last?.promptTokS)} />
                <StatTile label={t("mon.genTokS")} value={fmtTok(last?.genTokS)} />
                <StatTile label={t("mon.promptTotal")} value={fmtCount(s.promptTotal)} />
                <StatTile label={t("mon.genTotal")} value={fmtCount(s.predTotal)} />
                <StatTile label={t("mon.promptAvg")} title={t("mon.avgHint")} value={fmtTok(s.promptAvgTokS)} />
                <StatTile label={t("mon.genAvg")} title={t("mon.avgHint")} value={fmtTok(s.predAvgTokS)} />
                <StatTile label={t("mon.queue")} value={queue !== undefined ? String(Math.round(queue)) : "—"} />
                <StatTile label={t("mon.activeSlots")} value={busySlots === null ? "—" : totalSlots !== null ? `${busySlots.length}/${totalSlots}` : String(busySlots.length)} />
              </div>
              <div>
                <div className="flex items-center gap-3 text-[10px] text-fg-muted mb-1">
                  <span>{t("mon.rateHistory")}</span>
                  <span className="ml-auto flex items-center gap-2.5">
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-[2px] rounded bg-cyan" />{t("mon.promptRate")}</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-[2px] rounded bg-green" />{t("mon.genRate")}</span>
                  </span>
                </div>
                <Sparkline samples={s.history} />
              </div>
              {busySlots !== null && busySlots.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {busySlots.slice(0, 8).map((sl, i) => (
                    <span key={String(sl.id ?? i)} className={`badge badge-xs border ${slotChipCls(sl.state ?? (sl.is_processing ? "generating" : undefined))}`}>
                      #{sl.id ?? "?"}{sl.state ? ` · ${sl.state}` : ""}
                    </span>
                  ))}
                  {busySlots.length > 8 && <span className="text-[10px] text-fg-faint self-center">+{busySlots.length - 8}</span>}
                </div>
              )}
              {s.metrics !== null && (
                <Section
                  id={`${s.port}:metrics`}
                  open={!!openPanels[`${s.port}:metrics`]}
                  onToggle={togglePanel}
                  label={`/metrics (${(s.metrics.length / 1024).toFixed(1)} KB)`}
                >
                  <pre className="max-h-[200px] overflow-y-auto mt-1 px-2 py-1 rounded bg-base text-[10px] font-mono text-fg-muted whitespace-pre-wrap">
                    {s.metrics}
                  </pre>
                </Section>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Section id={`${s.port}:slots`} open={!!openPanels[`${s.port}:slots`]} onToggle={togglePanel} label="/slots">
                  <pre className="max-h-[160px] overflow-y-auto mt-1 px-2 py-1 rounded bg-base text-[10px] font-mono text-fg-muted whitespace-pre-wrap">
                    {s.slots !== null ? JSON.stringify(s.slots, null, 1) : "—"}
                  </pre>
                </Section>
                <Section id={`${s.port}:props`} open={!!openPanels[`${s.port}:props`]} onToggle={togglePanel} label="/props">
                  <pre className="max-h-[160px] overflow-y-auto mt-1 px-2 py-1 rounded bg-base text-[10px] font-mono text-fg-muted whitespace-pre-wrap">
                    {s.props !== null ? JSON.stringify(s.props, null, 1) : "—"}
                  </pre>
                </Section>
              </div>
            </div>
            );
          })
        )}
      </div>
    </div>
  );
}
