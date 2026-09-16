import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  estimateMemory,
  getServerLogs,
  launchServer,
  listServers,
  serverHealth,
  stopServer,
  type MemoryEstimate,
} from "../lib/api";
import { buildEffectiveFlagValues, buildLaunchArgs, flattenArgs, renderCommand } from "../flags/core";
import type { FlagValues } from "../flags/types";
import CommandPreview from "./CommandPreview";
import PresetsPanel, { type PresetData } from "./PresetsPanel";
import ConfirmDialog from "./ConfirmDialog";
import ModelAliasInput from "./ModelAliasInput";
import { modelDisplayName } from "../lib/model-aliases";
import { useFlags } from "../store-flags";
import { basePort, effectiveFor, useScopes } from "../store-scopes";
import { useQl, type QlTab } from "../store-ql";
import { useApp } from "../store";
import { useT } from "../i18n";

import { ghostBtn, inputCls, labelCls, secondaryBtn, selectCls } from "../lib/ui";
import { saveSettingsMerged } from "../lib/settings-save";

function fmtGb(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GB`;
}

/** Free-editing numeric field. A controlled `<input type="number">` snaps back on every invalid
 *  intermediate state (you can't clear it, and retyping 8080 → 9999 means deleting down to one
 *  digit first). This keeps a string draft while focused, commits valid numbers as you type, and
 *  only snaps back to the committed value on blur. */
function NumField({ value, onCommit, onClear, className = "w-24" }: {
  value: number;
  onCommit: (n: number) => void;
  /** Called when the field is cleared and blurred — ctx/threads revert to their defaults. */
  onClear?: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? String(value)}
      onChange={(e) => {
        const v = e.target.value.replace(/\D/g, "").slice(0, 6);
        setDraft(v);
        if (v !== "") onCommit(Number(v));
      }}
      onBlur={() => {
        if (draft === "") onClear?.();
        setDraft(null);
      }}
      className={`${inputCls} ${className}`}
    />
  );
}

export default function QuickLaunchView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const { settings, engines } = useApp();
  const { model: storeModel, setModel, applyValues, binaryTag, setBinaryTag } = useFlags();
  const { global, overrides, loaded: scopesLoaded } = useScopes();

  // tab state lives in an app-lifetime store so it survives page switches
  const tabs = useQl((s) => s.tabs);
  const activeId = useQl((s) => s.activeId);
  const patchTab = useQl((s) => s.patchTab);
  const removeTab = useQl((s) => s.removeTab);
  const setActiveId = useQl((s) => s.setActiveId);
  const active = tabs.find((x) => x.id === activeId) ?? tabs[0];

  // build the initial tab set once per app session (running servers + one idle).
  // Waits for scopes so the first idle tab's port comes from the Configure `port` flag.
  useEffect(() => {
    if (!settings || !scopesLoaded || useQl.getState().initialized) return;
    void useQl
      .getState()
      .init(settings.engine_exe || engines[0]?.path || "", basePort());
  }, [settings, engines, scopesLoaded]);

  // on (re)show: mark running tabs whose server died while we were away
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    listServers()
      .then((list) => {
        if (!alive) return;
        useQl.getState().reconcile(new Set(list.map((s) => s.port)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible]);

  // re-seed idle tabs once scopes finish loading (covers opening QL early). Deliberately NOT
  // re-run on later scope edits — per-tab quick-param edits and applied presets must survive.
  useEffect(() => {
    if (!scopesLoaded) return;
    const { global, overrides } = useScopes.getState();
    for (const x of useQl.getState().tabs) {
      if (!x.running) patchTab(x.id, { values: effectiveFor(global, overrides, x.model) });
    }
  }, [scopesLoaded, patchTab]);

  // keep the shared flags store pointing at the active tab — PresetsPanel's
  // "Save Current" and Benchmarks read it. Writing equal values back is a no-op
  // for the external-change effect below (it only acts when they differ).
  useEffect(() => {
    if (!active) return;
    setModel(active.model);
    applyValues(active.values);
  }, [active?.id, active?.model, active?.values, setModel, applyValues]);

  // external model pick (e.g. ModelsView "Use in Quick Launch") → adopt into the
  // active tab when it is idle. Read the CURRENT flags/scopes state at run time — the closure's
  // `storeModel` can be one commit stale, and re-patching with it fights the tab→flags sync effect
  // above: each effect reverts the other's write every cycle until React throws "Maximum update
  // depth exceeded" (the whole tree unmounts → white screen on model pick in an idle tab).
  useEffect(() => {
    if (!active) return;
    const sm = useFlags.getState().model;
    if (sm === active.model) return;
    if (sm && !active.running) {
      const { global: g, overrides: o } = useScopes.getState();
      patchTab(active.id, { model: sm, values: effectiveFor(g, o, sm) });
    }
  }, [storeModel, active?.id, active?.model, active?.running, global, overrides, patchTab]);

  // sync the flag-core binary gate with the active tab's engine version
  useEffect(() => {
    const eng = engines.find((e) => e.path === active?.engineExe);
    if (eng) setBinaryTag(eng.version ?? "custom");
  }, [active?.engineExe, engines, setBinaryTag]);

  // --- transient error toasts (top layer, auto-dismiss in ~2.5s) -----------------
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((text: string) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts, { id, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 2500);
  }, []);

  // ports we stopped ourselves — their exit event is not news (taskkill's exit code is unreliable)
  const stoppingPorts = useRef<Set<number>>(new Set());

  // --- server events: exit toasts only ----------------------------------------
  // State routing (appendLog / markExited) lives in app-lifetime lib/server-events.ts, so log
  // lines keep landing while this page is hidden.
  useEffect(() => {
    const un2 = listen<{ port: number; code: number | null }>("server-exited", (e) => {
      if (stoppingPorts.current.delete(e.payload.port)) return; // manual stop — no toast
      if (e.payload.code !== null) pushToast(t("ql.serverExited", { code: e.payload.code }));
    });
    return () => {
      un2.then((f) => f());
    };
  }, [pushToast, t]);

  // health polling for every running tab — gated on `visible` (view stays mounted on other tabs);
  // the immediate pass below refreshes flags the moment the page is shown again.
  const runningPorts = tabs.filter((x) => x.running).map((x) => x.port).join(",");
  useEffect(() => {
    if (!visible || !runningPorts) return;
    const ports = runningPorts.split(",").map(Number);
    const checkAll = async () => {
      for (const p of ports) {
        let ok = false;
        try {
          ok = await serverHealth(p);
        } catch {
          /* unreachable */
        }
        useQl.getState().setHealthy(p, ok);
      }
    };
    void checkAll();
    const id = setInterval(checkAll, 3000);
    return () => clearInterval(id);
  }, [visible, runningPorts]);

  /** command preview section expanded (default collapsed) */
  const [cmdOpen, setCmdOpen] = useState(false);

  // --- active tab derived values ----------------------------------------------
  // The tab's port is authoritative (Rust appends it last at launch) — override the
  // Configure-scope `port` flag so the preview shows exactly what will run.
  const result = useMemo(
    () =>
      buildLaunchArgs({
        tool: "llama-server",
        model: active?.model ?? "",
        flags: { ...(active?.values ?? {}), port: active?.port },
        binaryTag,
      }),
    [active?.model, active?.values, active?.port, binaryTag],
  );
  const flatArgs = useMemo(() => flattenArgs(result.args), [result]);
  const commandLine = renderCommand("llama-server", result);

  const canLaunch = Boolean(active && active.model && active.engineExe && !result.error && active.port >= 1);

  // toast when a command-build error appears (deduped so re-renders don't re-fire it)
  const lastBuildError = useRef<string | null>(null);
  useEffect(() => {
    if (result.error && result.error !== lastBuildError.current) pushToast(result.error);
    lastBuildError.current = result.error;
  }, [result.error, pushToast]);

  // memory estimate
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<MemoryEstimate | null>(null);
  // A stale estimate is worse than none — drop it whenever the launch args (model/ctx/ngl/port…) change.
  useEffect(() => {
    setEstimate(null);
  }, [flatArgs]);

  const runEstimate = async () => {
    if (!active || !active.engineExe || !active.model) return;
    setEstimating(true);
    try {
      const est = await estimateMemory(active.engineExe, flatArgs);
      setEstimate(est);
    } catch (e) {
      setEstimate({
        ok: false,
        error: String(e),
        rows: [],
        total_model_mib: 0,
        total_context_mib: 0,
        total_compute_mib: 0,
      });
      pushToast(String(e));
    } finally {
      setEstimating(false);
    }
  };

  // --- tab actions -------------------------------------------------------------
  // In-flight launch guard: a fast second click on Start would pass the duplicate-tab check
  // above and hit Rust's registry check for the very port we just claimed — toasting "port
  // occupied" for a launch that is actually succeeding.
  const launching = useRef(false);

  const start = async () => {
    if (!active || launching.current) return;
    if (tabs.some((x) => x.id !== active.id && x.port === active.port)) {
      pushToast(t("ql.portInUse", { port: active.port }));
      return;
    }
    launching.current = true;
    try {
      stoppingPorts.current.delete(active.port); // clear any stale flag from a lost exit event
      await launchServer(active.engineExe, flatArgs, active.port);
      patchTab(active.id, { running: true, logs: [], lastExitCode: null });
      // Seed immediately from the ring so lines emitted before this point aren't lost to the wipe above.
      try {
        const ring = await getServerLogs(active.port);
        if (ring.length) patchTab(active.id, { logs: ring.slice(-500) });
      } catch {
        /* non-fatal — live events + log sync will fill it in */
      }
    } catch (e) {
      pushToast(String(e));
    } finally {
      launching.current = false;
    }
  };

  const stop = async () => {
    if (!active) return;
    try {
      stoppingPorts.current.add(active.port);
      await stopServer(active.port);
      patchTab(active.id, { running: false });
    } catch (e) {
      pushToast(String(e));
    }
  };

  /** Close a tab — a running one stops its server first (with confirm). */
  const [confirmClose, setConfirmClose] = useState<{ id: string; port: number } | null>(null);

  const closeTab = (id: string) => {
    const tab = tabs.find((x) => x.id === id);
    if (!tab) return;
    if (tab.running) {
      setConfirmClose({ id, port: tab.port });
      return;
    }
    removeTab(id);
  };

  const doCloseRunning = async () => {
    const c = confirmClose;
    setConfirmClose(null);
    if (!c) return;
    stoppingPorts.current.add(c.port);
    try {
      await stopServer(c.port);
    } catch {
      /* the process may already be gone */
    }
    removeTab(c.id);
  };

  const addTab = useCallback(() => {
    // preselect the user's default model for new tabs (if it still exists in the list)
    const dm = settings?.default_model;
    useQl.getState().addIdleTab(
      settings?.engine_exe || engines[0]?.path || "",
      basePort(),
      dm && settings.model_paths.includes(dm) ? dm : "",
    );
  }, [settings, engines]);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(commandLine);
    } catch {
      // clipboard unavailable — ignore, the text is selectable anyway
    }
  };

  /** FR3.1 — apply a loaded preset to the ACTIVE tab (panel is shared). */
  const applyPreset = (data: PresetData) => {
    if (!active) return;
    const patch: Partial<QlTab> = { values: buildEffectiveFlagValues((data.flags ?? {}) as FlagValues) };
    if (data.model) patch.model = data.model;
    if (typeof data.port === "number" && data.port > 0 && !active.running) patch.port = data.port;
    patchTab(active.id, patch);
  };

  // --- active tab field setters -------------------------------------------------
  const setEngineExe = (path: string) => {
    if (!active) return;
    const eng = engines.find((x) => x.path === path);
    patchTab(active.id, { engineExe: path });
    if (eng) setBinaryTag(eng.version ?? "custom");
  };

  const pickModel = async () => {
    const path = await openFileDialog({
      filters: [{ name: "GGUF", extensions: ["gguf"] }],
      multiple: false,
    });
    if (typeof path !== "string" || !path || !active) return;
    patchTab(active.id, { model: path, values: effectiveFor(global, overrides, path) });
    // persist so the pick shows up in the dropdown now and on next launch (non-fatal — it works this session either way)
    await saveSettingsMerged((s) => ({
      model_paths: s.model_paths.includes(path) ? s.model_paths : [...s.model_paths, path],
    })).catch(() => {});
  };

  const setActiveFlag = (id: string, value: unknown) => {
    if (!active) return;
    const values = { ...active.values };
    if (value === undefined) delete values[id];
    else values[id] = Array.isArray(value) ? [...(value as unknown[])] : value;
    patchTab(active.id, { values });
  };

  // auto-scroll the active tab's log view — only while near the bottom, so scrolling up to read
  // history mid-run isn't yanked back down on every appended line (same pattern as ChatView)
  const logRef = useRef<HTMLPreElement>(null);
  const logAtBottomRef = useRef(true);
  const prevLogTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevLogTabRef.current !== active?.id) {
      prevLogTabRef.current = active?.id;
      logAtBottomRef.current = true; // switching tabs lands on the latest line
    }
    const el = logRef.current;
    if (el && logAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [active?.logs.length, active?.id]);

  // dropdown options: known models + whatever the active tab has selected
  const modelOptions = Array.from(
    new Set([...(settings?.model_paths ?? []), ...(active?.model ? [active.model] : [])]),
  );

  const tabLabel = (tab: { model: string; port: number }) => {
    // alias-first display; fallback keeps the current full-basename behavior
    const name = tab.model ? modelDisplayName(tab.model, settings?.model_aliases, tab.model.split(/[\\/]/).pop()) : t("ql.noModel");
    return t("ql.tabLabel", { name, port: tab.port });
  };

  // No page-level scroll: the live log (flex-1) absorbs spare height and scrolls internally.
  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      {/* server tabs — each one is an independent llama-server session */}
      <div className="tabs tabs-lift tabs-sm flex items-center pt-2 px-3 gap-1 border-b border-line bg-surface overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveId(tab.id)}
            title={`${tab.model || t("ql.noModel")} — :${tab.port}`}
            className={`group tab ${active?.id === tab.id ? "tab-active" : ""} flex items-center gap-1.5 text-xs cursor-pointer select-none shrink-0 whitespace-nowrap ${
              active?.id === tab.id ? "text-accent-text" : "text-fg-muted hover:bg-hover"
            }`}
          >
            <span
              className={`status ${
                tab.running ? (tab.healthy ? "status-success" : "status-warning") : ""
              }`}
            />
            <span>{tabLabel(tab)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              title={t("ql.closeTab")}
              className="text-fg-faint hover:text-red px-1"
            >
              <i className="fa-solid fa-xmark" aria-hidden />
            </button>
          </div>
        ))}
        <button
          onClick={addTab}
          title={t("ql.addTab")}
          className="btn btn-xs btn-ghost shrink-0"
        >
          <i className="fa-solid fa-plus" aria-hidden />
        </button>
      </div>

      {!active ? (
        <div className="flex-1 flex items-center justify-center text-sm text-fg-faint">
          {t("app.loading")}
        </div>
      ) : (
        <>
          {/* engine + model */}
          <div className="shrink-0 px-3 py-2 border-b border-line bg-surface space-y-2">
            <div className="flex gap-3 text-xs items-center flex-wrap">
              <span className={labelCls}>{t("ql.engine")}</span>
              <select
                value={active.engineExe}
                onChange={(e) => setEngineExe(e.target.value)}
                className={`${selectCls} min-w-[240px] max-w-[380px] flex-1`}
              >
                <option value="">{t("ql.pickEngine")}</option>
                {engines.map((e) => (
                  <option key={e.path} value={e.path}>
                    {e.name}
                    {e.version ? ` (${e.version})` : ""}
                  </option>
                ))}
              </select>
              <span className={labelCls}>{t("ql.model")}</span>
              <select
                value={active.model}
                onChange={(e) => {
                  const m = e.target.value;
                  patchTab(active.id, { model: m, values: effectiveFor(global, overrides, m) });
                }}
                className={`${selectCls} min-w-[240px] max-w-[380px] flex-1`}
              >
                <option value="">{t("ql.pickModel")}</option>
                {modelOptions.map((p) => (
                  <option key={p} value={p}>
                    {/* alias if set, else basename minus .gguf — keeps long names readable inside the capped select */}
                    {modelDisplayName(p, settings?.model_aliases)}
                  </option>
                ))}
              </select>
              <button onClick={pickModel} className={secondaryBtn}>
                {t("common.browse")}
              </button>
            </div>
          </div>

          {/* quick params */}
          <div className="px-3 py-2 border-b border-line bg-surface space-y-2">
            <div className="text-xs font-medium text-fg-bright">{t("ql.quickParams")}</div>
            <div className="flex gap-3 text-xs items-center flex-wrap">
              {/* Each label + field is wrapped so a wrap never separates the two. */}
              <div className="flex items-center">
                {/* per-tab port — overrides the Configure `port` flag for this tab */}
                <span className={labelCls}>{t("ql.port")}</span>
                <NumField
                  key={`port-${active.id}`}
                  value={active.port}
                  onCommit={(p) => {
                    if (p >= 1 && p <= 65535) patchTab(active.id, { port: p }); // 0/NaN would launch a doomed server
                  }}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className={labelCls}>{t("ql.ctx")}</span>
                {/* Clearing + blur reverts to the default; 0 would crash llama-server at startup. */}
                <NumField
                  key={`ctx-${active.id}`}
                  value={active.values.ctx_size ?? 4096}
                  onCommit={(n) => {
                    if (n >= 1) setActiveFlag("ctx_size", n);
                  }}
                  onClear={() => setActiveFlag("ctx_size", undefined)}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className={labelCls}>{t("ql.ngl")}</span>
                <input
                  type="text"
                  value={String(active.values.gpu_layers ?? "auto")}
                  onChange={(e) => setActiveFlag("gpu_layers", e.target.value)}
                  placeholder="auto / all / 99"
                  className={`${inputCls} w-24`}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className={labelCls}>{t("ql.threads")}</span>
                {/* Clearing + blur reverts to auto (-1); 0 is not a valid thread count. */}
                <NumField
                  key={`t-${active.id}`}
                  value={active.values.threads ?? -1}
                  className="w-20"
                  onCommit={(n) => {
                    if (n >= 1) setActiveFlag("threads", n);
                  }}
                  onClear={() => setActiveFlag("threads", undefined)}
                />
              </div>
              <div className="flex items-center gap-1.5">
                {/* display alias for this tab's model — persisted per path, shared with the Models page */}
                <span className={labelCls}>{t("ql.alias")}</span>
                <ModelAliasInput path={active.model} disabled={!active.model} className="w-32" />
              </div>
            </div>
          </div>

          {/* memory estimate */}
          <div className="px-3 py-2 border-b border-line bg-surface space-y-2">
            <div className="flex gap-2 items-center">
              <button
                onClick={runEstimate}
                disabled={!canLaunch || estimating}
                className="btn btn-primary btn-xs"
              >
                {estimating ? t("ql.estimating") : t("ql.estimateMemory")}
              </button>
              <span className="text-xs text-fg-faint">{t("ql.estimateHint")}</span>
            </div>
            {estimate && estimate.ok && (
              <div className="flex gap-3 flex-wrap">
                {estimate.rows.map((r) => (
                  <div
                    key={r.device + r.kind}
                    className="px-2 py-1 rounded bg-base border border-line text-fg text-[11px] font-mono"
                  >
                    <span className={r.kind === "ram" ? "text-cyan" : "text-green"}>
                      {r.device}
                    </span>{" "}
                    · model {fmtGb(r.model_mib)} / ctx {fmtGb(r.context_mib)} / compute{" "}
                    {fmtGb(r.compute_mib)}
                  </div>
                ))}
                <div className="px-2 py-1 rounded bg-accent-subtle border border-accent-border text-[11px] font-mono text-accent-text">
                  {t("ql.total", {
                    model: fmtGb(estimate.total_model_mib),
                    ctx: fmtGb(estimate.total_context_mib),
                    compute: fmtGb(estimate.total_compute_mib),
                  })}
                </div>
              </div>
            )}
          </div>

          {/* command preview */}
          <CommandPreview
            open={cmdOpen}
            onToggle={() => setCmdOpen((o) => !o)}
            title={t("ql.command")}
            warnings={result.warnings.length}
            extra={
              // copy lives on the title row — visible without expanding
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  copyCommand();
                }}
                className={`${ghostBtn} ml-auto`}
              >
                {t("ql.copyCommand")}
              </button>
            }
            text={commandLine}
            tall
          >
            {result.warnings.map((w) => (
              <div key={w} role="alert" className="alert alert-soft alert-warning">
                {w}
              </div>
            ))}
          </CommandPreview>

          {/* FR3 — presets: shared across tabs, applied to the active one */}
          <PresetsPanel onApply={applyPreset} currentPort={active.port} />

          {/* reconnected servers have no stdout pipe — explain why the terminal stays quiet */}
          {active.running && active.reconnected && (
            <div className="shrink-0 px-3 py-1.5 border-b border-line bg-raised text-xs text-fg-muted">
              <i className="fa-solid fa-plug mr-1.5" aria-hidden />
              {t("ql.reconnected")}
            </div>
          )}

          {/* logs — the pre is ALWAYS rendered (it's the flex-1 filler that pins the bottom bar); kept visible after an unexpected exit */}
          <pre
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              logAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="flex-1 min-h-0 overflow-y-auto bg-surface px-3 py-2 text-[11px] leading-relaxed text-fg-muted font-mono"
          >
            {active.logs.length
              ? active.logs.join("\n")
              : active.running && !active.reconnected
                ? t("ql.waitingOutput")
                : ""}
          </pre>
        </>
      )}

      {/* start/stop — fixed at the bottom, always visible (like Settings' save) */}
      {active && (
        <div className="shrink-0 flex items-center gap-2 border-t border-line bg-surface px-3 py-2">
          {active.running && (
            <span className="flex items-center gap-1 text-xs">
              <span
                className={`status ${active.healthy ? "status-success" : "status-warning"}`}
              />
              {active.healthy ? t("ql.running", { port: active.port }) : t("ql.starting", { port: active.port })}
            </span>
          )}
          <div className="flex-1" />
          {!active.running ? (
            // the toast only lives 2.5s — a disabled Start still explains itself on hover
            <div className="tooltip tooltip-top">
              <div className="tooltip-content">{result.error ?? ""}</div>
              <button onClick={start} disabled={!canLaunch} className="btn btn-xs btn-primary">
                <i className="fa-solid fa-play" aria-hidden />
                {t("ql.startServer")}
              </button>
            </div>
          ) : (
            <button onClick={stop} className="btn btn-xs btn-soft btn-error">
              <i className="fa-solid fa-stop" aria-hidden />
              {t("ql.stop")}
            </button>
          )}
        </div>
      )}

      {/* transient error notifications — top-right of the content area (anchored below the title bar), auto-dismiss */}
      <div className="absolute top-3 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map((x) => (
            <motion.div
              key={x.id}
              role="alert"
              className="alert alert-error alert-soft"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              {x.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <ConfirmDialog
        open={confirmClose !== null}
        title={t("ql.closeTab")}
        message={t("ql.closeRunningConfirm", { port: confirmClose?.port ?? 0 })}
        confirmLabel={t("ql.stopAndClose")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doCloseRunning()}
        onCancel={() => setConfirmClose(null)}
      />
    </div>
  );
}
