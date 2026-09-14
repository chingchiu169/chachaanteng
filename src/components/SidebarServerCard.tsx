import { useRef, useState } from "react";
import { stopServer } from "../lib/api";
import { modelDisplayName } from "../lib/model-aliases";
import { isMac } from "../lib/platform";
import { useT } from "../i18n";
import { useApp } from "../store";
import { useMonitor, type ServerPanel } from "../store-monitor";
import { useQl, type QlTab } from "../store-ql";

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function fmtCount(v: number | null): string {
  return v === null ? "—" : Math.round(v).toLocaleString();
}

/** tok/s values — whole numbers are plenty at this scale (same as MonitorView's tiles). */
function fmtTokS(v: number | null): string {
  return v === null ? "—" : `${Math.round(v)} t/s`;
}

/** Engine display tag — version + backend type derived from the install dir name
 *  ("b10919-cpu" → "b10919 · cpu", "b7184-cuda-12.4" → "b7184 · cuda-12.4"). */
function engineTag(eng: { name: string; version: string | null } | undefined): string {
  if (!eng) return "custom";
  const ver = eng.version ?? "";
  if (ver && eng.name.startsWith(ver + "-")) {
    return `${ver} · ${eng.name.slice(ver.length + 1)}`;
  }
  return ver || eng.name;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[10px] leading-4">
      <span className="text-fg-muted shrink-0">{label}</span>
      <span className="font-mono text-fg-bright truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

/** One live card for a running server. Collapsed (default): model + port header and the two
 *  instantaneous tok/s rates only. Expanded: engine type, totals, active-time averages and
 *  per-process CPU/RAM/GPU/VRAM. */
function ServerCard({ tab, panel }: { tab: QlTab; panel: ServerPanel | undefined }) {
  const t = useT();
  const { engines, settings } = useApp();
  const [expanded, setExpanded] = useState(false);
  // ports we are stopping right now — a double-click must not fire two stop_server calls
  const stopping = useRef<Set<number>>(new Set());

  const eng = engines.find((e) => e.path === tab.engineExe);
  // alias-first display; fallback keeps the current basename behavior (full path stays in the tooltip)
  const modelBase = tab.model ? modelDisplayName(tab.model, settings?.model_aliases, tab.model.split(/[\\/]/).pop()) : "";
  // Instantaneous rates — the latest poll sample (null until the first measurable tick).
  const lastSample = panel?.history[panel.history.length - 1];

  const stop = async () => {
    if (stopping.current.has(tab.port)) return;
    stopping.current.add(tab.port);
    try {
      await stopServer(tab.port);
      // Rust removes the registry entry before killing, so no "server-exited" event follows.
      useQl.getState().patchTab(tab.id, { running: false });
    } catch {
      // server already gone or kill failed — leave the card as-is; the next health/log sync
      // will drop it if the port is really dead.
    } finally {
      stopping.current.delete(tab.port);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface p-2">
      {/* Header doubles as the expand/collapse toggle */}
      <button
        onClick={() => setExpanded((x) => !x)}
        className="mb-1 flex w-full min-w-0 items-center gap-1.5 text-left"
        title={expanded ? "Collapse" : "Expand"}
      >
        <i className="fa-solid fa-server shrink-0 text-[10px] text-fg-muted" aria-hidden />
        <span className="min-w-0 truncate text-xs font-medium" title={tab.model}>
          {modelBase}
        </span>
        <span className="shrink-0 text-[10px] text-fg-faint">:{tab.port}</span>
        <i
          className={`fa-solid fa-chevron-right ml-auto shrink-0 text-[9px] text-fg-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        />
      </button>
      {expanded && (
        <div className="space-y-0.5">
          <Row label={t("side.engine")} value={engineTag(eng)} />
          <Row label={t("side.promptRate")} value={fmtTokS(lastSample?.promptTokS ?? null)} />
          <Row label={t("side.genRate")} value={fmtTokS(lastSample?.genTokS ?? null)} />
          <Row label={t("side.promptTotal")} value={fmtCount(panel?.promptTotal ?? null)} />
          <Row label={t("side.promptAvg")} value={fmtTokS(panel?.promptAvgTokS ?? null)} />
          <Row label={t("side.tokenTotal")} value={fmtCount(panel?.predTotal ?? null)} />
          <Row label={t("side.tokenAvg")} value={fmtTokS(panel?.predAvgTokS ?? null)} />
          <Row label="CPU" value={panel ? (panel.cpuPercent === null ? "—" : `${panel.cpuPercent.toFixed(1)}%`) : "—"} />
          <Row label="RAM" value={panel && panel.ramBytes > 0 ? fmtBytes(panel.ramBytes) : "—"} />
          {!isMac() && (
            <>
              <Row label="GPU" value={panel?.gpuUtilPercent === null || panel?.gpuUtilPercent === undefined ? "—" : `${Math.round(panel.gpuUtilPercent)}%`} />
              <Row label="VRAM" value={panel && panel.gpuMemBytes !== null ? fmtBytes(panel.gpuMemBytes) : "—"} />
            </>
          )}
        </div>
      )}
      {!expanded && (
        <div className="space-y-0.5">
          <Row label={t("side.promptRate")} value={fmtTokS(lastSample?.promptTokS ?? null)} />
          <Row label={t("side.genRate")} value={fmtTokS(lastSample?.genTokS ?? null)} />
        </div>
      )}
      <button onClick={() => void stop()} className="btn btn-xs btn-error mt-1.5 w-full">
        <i className="fa-solid fa-stop" aria-hidden /> {t("side.stop")}
      </button>
    </div>
  );
}

/** Stacked live cards below the sidebar menu — one per running server, gone when none run. */
export default function SidebarServerCard() {
  const tabs = useQl((s) => s.tabs);
  const servers = useMonitor((s) => s.servers);
  const running = tabs.filter((x) => x.running);
  if (running.length === 0) return null;
  const byPort = new Map(servers.map((p) => [p.port, p]));
  return (
    <div className="flex flex-col gap-1.5">
      {running.map((tab) => (
        <ServerCard key={tab.id} tab={tab} panel={byPort.get(tab.port)} />
      ))}
    </div>
  );
}
