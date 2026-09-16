import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  benchLines,
  benchRunContext,
  consumePendingExit,
  onBenchExit,
  onBenchLine,
  resetBenchEvents,
  setBenchRunContext,
} from "../lib/bench-events";
import {
  benchStart,
  benchStatus,
  benchStop,
  ensureWikitext2,
  getBenchLogs,
  listPresets,
  type BenchStatus,
} from "../lib/api";
import { modelDisplayName } from "../lib/model-aliases";
import { buildBenchmarkArgs, extractBenchTs, extractPpl } from "../flags/bench";
import { getDefaultValues } from "../flags/core";
import type { FlagValues } from "../flags/types";
import { useApp } from "../store";
import { fmtClock } from "../lib/time";
import { useFlags } from "../store-flags";
import { useT } from "../i18n";

import { ghostBtnMuted, inputCls, labelCls, secondaryBtn, selectCls } from "../lib/ui";
import CommandPreview from "./CommandPreview";
const HISTORY_KEY = "chachaanteng-bench-history";

/** Reference perplexity presets (gui = our defaults, llamacpp = upstream CI settings). */
const PERPLEXITY_PRESETS: Record<string, {
  ctx: string; batch: string; ubatch: string; threads: string; gpuLayers: string;
  flashAttention: string; cacheTypeK: string; cacheTypeV: string; mmap: boolean;
  chunks: string; pplStride: string; warmup: boolean;
}> = {
  gui: { ctx: "4096", batch: "2048", ubatch: "512", threads: "-1", gpuLayers: "auto", flashAttention: "auto", cacheTypeK: "f16", cacheTypeV: "f16", mmap: true, chunks: "5", pplStride: "0", warmup: true },
  llamacpp: { ctx: "512", batch: "2048", ubatch: "512", threads: "-1", gpuLayers: "auto", flashAttention: "auto", cacheTypeK: "f16", cacheTypeV: "f16", mmap: true, chunks: "-1", pplStride: "0", warmup: true },
};

type PplState = (typeof PERPLEXITY_PRESETS)[string];

interface HistoryEntry {
  tool: string;
  model: string;
  /** Full path — lets the display resolve a user-set alias (absent on pre-alias entries). */
  model_path?: string;
  started_at_ms: number;
  duration_ms: number;
  ts_values: number[];
  /** perplexity runs report PPL instead of t/s */
  ppl?: number | null;
  exit_code: number | null;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function BenchmarksView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const { settings, engines } = useApp();
  const { model: storeModel, setModel, values: storeValues } = useFlags();

  // engine (bench tools live next to llama-server.exe) — derived; no UI sets it
  const engineExe = engines.find((e) => e.path === settings?.engine_exe)?.path ?? engines[0]?.path ?? "";

  // source + type
  const [benchmarkType, setBenchmarkType] = useState<"bench" | "perplexity">("bench");
  const [sourceType, setSourceType] = useState<"current" | "preset" | "manual">("current");
  const [presets, setPresets] = useState<{ name: string; data: Record<string, unknown> }[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [manualModel, setManualModel] = useState("");
  /** command preview section expanded (default collapsed) */
  const [cmdOpen, setCmdOpen] = useState(false);

  // Re-listed each time the page is shown — presets changed via Quick Launch's panel while
  // this page was hidden must appear without a restart.
  useEffect(() => {
    if (!visible) return;
    listPresets()
      .then((list) => setPresets(list.map((p) => ({ name: p.name, data: p.data }))))
      .catch(() => {});
  }, [visible]);

  const modelOptions = Array.from(new Set([...(settings?.model_paths ?? []), ...(storeModel ? [storeModel] : [])]));

  // bench controls
  const [reps, setReps] = useState(5);
  const [nPrompt, setNPrompt] = useState(512);
  const [nGen, setNGen] = useState(128);
  const [outputFormat, setOutputFormat] = useState("md");

  // perplexity controls — one object so a preset applies atomically (strings — free-form like the reference)
  const [pplPreset, setPplPreset] = useState<"gui" | "llamacpp" | "clean" | "custom">("gui");
  const [ppl, setPpl] = useState<PplState>({ ...PERPLEXITY_PRESETS.gui });
  const [promptFile, setPromptFile] = useState("");
  const [wikiBusy, setWikiBusy] = useState(false);
  const [wikiNote, setWikiNote] = useState("");

  // run state + output
  const [running, setRunning] = useState<BenchStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [, setTick] = useState(0); // elapsed-time ticker
  const logRef = useRef<HTMLPreElement>(null);
  const startedAtRef = useRef<number | null>(null);
  // Every line of the current run lives in lib/bench-events.ts (app-lifetime module buffer),
  // and the exit handler extracts t/s from it so it never depends on backend ring-buffer timing.

  // resolve the selected model + flag source for the arg builder (before effects that use it)
  const { currentModel, sourceFlags } = useMemo(() => {
    if (sourceType === "preset" && selectedPreset) {
      const preset = presets.find((p) => p.name === selectedPreset);
      const data = (preset?.data ?? {}) as unknown as { model?: string; flags?: Record<string, unknown> };
      return { currentModel: String(data.model || ""), sourceFlags: (data.flags ?? {}) as FlagValues };
    }
    if (sourceType === "manual") return { currentModel: manualModel.trim(), sourceFlags: {} as FlagValues };
    return { currentModel: storeModel, sourceFlags: storeValues };
  }, [sourceType, selectedPreset, presets, manualModel, storeModel, storeValues]);

  useEffect(() => {
    if (!running || !visible) return; // display-only ticker — paused while the page is hidden
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running, visible]);

  // Record a finished run into history — shared by the live exit handler and the on-show
  // recovery path (e.g. a run that finished across an HMR update or page reload).
  const recordExit = useCallback(
    async (info: { code: number | null; atMs: number }) => {
      try {
        // Prefer the lines we accumulated live; fall back to the backend buffer.
        let full = benchLines();
        if (full.length === 0) full = await getBenchLogs();
        const fullText = full.join("\n");
        const c = benchRunContext();
        const modelPath = c?.model ?? "";
        const ts = extractBenchTs(fullText);
        const entry: HistoryEntry = {
          tool: c?.tool ?? "",
          model: modelPath ? (modelPath.split(/[\\/]/).pop() || modelPath) : "",
          model_path: modelPath,
          started_at_ms: c?.startedAtMs ?? info.atMs,
          duration_ms: c?.startedAtMs ? info.atMs - c.startedAtMs : 0,
          // tg (token generation) only — that's the chat typing speed; pp is prefill.
          ts_values: ts.tg,
          ppl: extractPpl(fullText),
          exit_code: info.code,
        };
        setHistory((prev) => {
          const next = [entry, ...prev].slice(0, 20);
          try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
          } catch {
            /* non-fatal */
          }
          return next;
        });
      } finally {
        setRunning(null);
        startedAtRef.current = null;
      }
    },
    [],
  );

  // restore a benchmark that is still running (e.g. after an HMR update or page reload) — and
  // recover the history entry if it finished while we were away.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await benchStatus();
        if (!alive) return;
        if (status) {
          setRunning(status);
          startedAtRef.current = status.started_at_ms;
          // Fresh session (app restarted mid-run): the module context is empty — seed it.
          if (!benchRunContext()) {
            setBenchRunContext({ tool: status.tool, model: "", startedAtMs: status.started_at_ms });
          }
          let buffered = benchLines();
          if (buffered.length === 0) buffered = await getBenchLogs();
          if (alive && buffered.length > 0) setLogs(buffered.slice(-500));
        } else {
          // A run finished while we were away — record it now.
          const exit = consumePendingExit();
          if (!exit || !benchRunContext()) return;
          await recordExit(exit);
        }
      } catch {
        /* app not ready */
      }
    })();
    return () => {
      alive = false;
    };
  }, [recordExit]);

  // live output + exit events — routed app-lifetime via lib/bench-events.ts, so lines and the
  // exit event keep landing while this page is hidden.
  useEffect(() => {
    const offLine = onBenchLine((line) => setLogs((l) => [...l.slice(-499), line]));
    const offExit = onBenchExit(async (info) => {
      consumePendingExit(); // we're handling it — don't let the next mount re-record it
      await recordExit(info);
    });
    return () => {
      offLine();
      offExit();
    };
  }, [recordExit]);

  // auto-scroll output
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const pickModelFile = async () => {
    const path = await openFileDialog({ filters: [{ name: "GGUF", extensions: ["gguf"] }], multiple: false });
    if (typeof path !== "string" || !path) return;
    setManualModel(path);
    setSourceType("manual");
  };

  const pickDataFile = async () => {
    const path = await openFileDialog({ filters: [{ name: "Text", extensions: ["raw", "txt"] }], multiple: false });
    if (typeof path !== "string" || !path) return;
    setPromptFile(path);
  };

  /** FR5.2 — download + extract WikiText-2 into the models dir on demand. */
  const fetchWikitext = async () => {
    setWikiBusy(true);
    setWikiNote("");
    try {
      const res = await ensureWikitext2();
      setPromptFile(res.path);
      setWikiNote(
        res.downloaded ? t("bench.wikiDownloaded", { path: res.path }) : t("bench.wikiPresent", { path: res.path }),
      );
    } catch (e) {
      setWikiNote(t("bench.wikiFailed", { err: String(e) }));
    } finally {
      setWikiBusy(false);
    }
  };

  const applyPplPreset = useCallback((name: string) => {
    if (name === "clean") {
      setPplPreset("clean");
      return;
    }
    const preset = PERPLEXITY_PRESETS[name];
    if (!preset) {
      setPplPreset("custom");
      return;
    }
    setPpl({ ...preset });
    setPplPreset(name as "gui" | "llamacpp");
  }, []);

  // mark the ppl preset custom whenever a control drifts from it
  const onPpl = useCallback(
    <K extends keyof PplState>(k: K, v: PplState[K]) => {
      setPpl((p) => ({ ...p, [k]: v }));
      if (pplPreset !== "custom" && pplPreset !== "clean") setPplPreset("custom");
    },
    [pplPreset],
  );

  const result = useMemo(
    () =>
      buildBenchmarkArgs({
        model: currentModel,
        benchmarkType,
        flags: sourceFlags,
        defaultFlags: getDefaultValues(),
        repetitions: reps,
        nPrompt,
        nGen,
        outputFormat,
        pplCleanRun: pplPreset === "clean",
        pplContextSize: Number(ppl.ctx) || 4096,
        pplBatchSize: Number(ppl.batch) || 2048,
        pplUbatchSize: Number(ppl.ubatch) || 512,
        pplThreads: ppl.threads.trim() === "" ? -1 : Number(ppl.threads),
        pplGpuLayers: ppl.gpuLayers,
        pplFlashAttention: ppl.flashAttention,
        pplCacheTypeK: ppl.cacheTypeK,
        pplCacheTypeV: ppl.cacheTypeV,
        pplMmap: ppl.mmap,
        chunks: ppl.chunks,
        pplStride: ppl.pplStride,
        warmup: ppl.warmup,
        promptFile,
      }),
    [currentModel, benchmarkType, sourceFlags, reps, nPrompt, nGen, outputFormat, pplPreset, ppl, promptFile],
  );

  const canRun = Boolean(engineExe && currentModel && !result.error && !running);

  const run = async () => {
    if (!canRun) return;
    setError("");
    setLogs([]);
    try {
      const status = await benchStart(engineExe, result.tool, result.args);
      const t0 = Date.now();
      startedAtRef.current = t0;
      resetBenchEvents({ tool: result.tool, model: currentModel, startedAtMs: t0 });
      setRunning(status);
    } catch (e) {
      setError(String(e));
    }
  };

  const stop = async () => {
    try {
      await benchStop();
    } catch (e) {
      setError(String(e));
    }
  };

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* non-fatal */
    }
  };

  const elapsedMs = running && startedAtRef.current ? Date.now() - startedAtRef.current : 0;
  // The per-second tick re-renders while running — derive the live stats only when new lines arrive.
  const { text: liveText, ts: liveTs, ppl: livePpl } = useMemo(() => {
    const text = logs.join("\n");
    return { text, ts: extractBenchTs(text).tg /* tg only — chat typing speed */, ppl: extractPpl(text) };
  }, [logs]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto">
      {/* type + source */}
      <div className="p-3 border-b border-line bg-surface space-y-2">
        <div className="text-xs font-medium text-fg-bright">{t("bench.targetTitle")}</div>
        <div className="flex gap-4 text-xs items-center flex-wrap">
          <span className={labelCls}>{t("bench.benchmarkLabel")}</span>
          <select value={benchmarkType} onChange={(e) => setBenchmarkType(e.target.value as "bench" | "perplexity")} className={`${selectCls} w-[240px]`}>
            <option value="bench">{t("bench.throughputOpt")}</option>
            <option value="perplexity">{t("bench.pplOpt")}</option>
          </select>
          <span className={labelCls}>{t("bench.sourceLabel")}</span>
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as "current" | "preset" | "manual")} className={`${selectCls} w-[160px]`}>
            <option value="current">{t("bench.currentOpt")}</option>
            <option value="preset">{t("bench.presetOpt")}</option>
            <option value="manual">{t("bench.manualOpt")}</option>
          </select>
          {sourceType === "preset" && (
            <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)} className={`${selectCls} min-w-[220px] max-w-[360px] flex-1`}>
              <option value="">{t("bench.pickPreset")}</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex gap-3 text-xs items-center flex-wrap">
          {sourceType === "current" && (
            <>
              <span className={labelCls}>{t("bench.modelLabel")}</span>
              <select value={storeModel} onChange={(e) => setModel(e.target.value)} className={`${selectCls} min-w-[240px] max-w-[400px] flex-1`}>
                <option value="">{t("ql.pickModel")}</option>
                {modelOptions.map((p) => (
                  // alias if set, else basename minus .gguf — keeps long names readable inside the capped select
                  <option key={p} value={p}>{modelDisplayName(p, settings?.model_aliases)}</option>
                ))}
              </select>
            </>
          )}
          {sourceType === "preset" && (
            <span className="text-xs text-fg-muted truncate max-w-[320px]" title={currentModel}>
              {t("bench.modelLabel")}: {currentModel ? modelDisplayName(currentModel, settings?.model_aliases) : t("bench.presetNoModel")}
            </span>
          )}
          {sourceType === "manual" && (
            <>
              <input value={manualModel} onChange={(e) => setManualModel(e.target.value)} placeholder="C:\models\....gguf" className={`${inputCls} min-w-[240px] max-w-[400px] flex-1`} />
              <button onClick={pickModelFile} className={secondaryBtn}>{t("common.browse")}</button>
            </>
          )}
        </div>
      </div>

      {/* bench controls */}
      {benchmarkType === "bench" && (
        <div className="p-3 border-b border-line bg-surface space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("bench.throughputControls")}</div>
          <div className="flex gap-3 text-xs items-center flex-wrap">
            <span className={labelCls}>{t("bench.reps")}</span>
            <input type="number" value={reps} onChange={(e) => setReps(Number(e.target.value))} className={`${inputCls} w-20`} />
            <span className={labelCls}>{t("bench.promptTokens")}</span>
            <input type="number" value={nPrompt} onChange={(e) => setNPrompt(Number(e.target.value))} className={`${inputCls} w-24`} />
            <span className={labelCls}>{t("bench.genTokens")}</span>
            <input type="number" value={nGen} onChange={(e) => setNGen(Number(e.target.value))} className={`${inputCls} w-24`} />
            <span className={labelCls}>{t("bench.format")}</span>
            <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)} className={`${selectCls} w-24`}>
              <option value="md">md</option>
              <option value="json">json</option>
              <option value="csv">csv</option>
            </select>
          </div>
        </div>
      )}

      {/* perplexity controls */}
      {benchmarkType === "perplexity" && (
        <div className="p-3 border-b border-line bg-surface space-y-2">
          <div className="flex gap-3 text-xs items-center flex-wrap">
            <span className={labelCls}>{t("bench.pplPresetLabel")}</span>
            <select value={pplPreset} onChange={(e) => applyPplPreset(e.target.value)} className={`${selectCls} w-36`}>
              <option value="gui">{t("bench.guiOpt")}</option>
              <option value="llamacpp">llama.cpp CI</option>
              <option value="clean">{t("bench.cleanOpt")}</option>
              <option value="custom">{t("bench.customOpt")}</option>
            </select>
          </div>
          {pplPreset !== "clean" && (
            <>
              <div className="flex gap-3 text-xs items-center flex-wrap">
                <span className={labelCls}>{t("bench.ctx")}</span>
                <input value={ppl.ctx} onChange={(e) => onPpl("ctx", e.target.value)} className={`${inputCls} w-20`} />
                <span className={labelCls}>{t("bench.batch")}</span>
                <input value={ppl.batch} onChange={(e) => onPpl("batch", e.target.value)} className={`${inputCls} w-20`} />
                <span className={labelCls}>{t("bench.ubatch")}</span>
                <input value={ppl.ubatch} onChange={(e) => onPpl("ubatch", e.target.value)} className={`${inputCls} w-20`} />
                <span className={labelCls}>{t("bench.threads")}</span>
                <input value={ppl.threads} onChange={(e) => onPpl("threads", e.target.value)} className={`${inputCls} w-20`} />
              </div>
              <div className="flex gap-3 text-xs items-center flex-wrap">
                <span className={labelCls}>{t("bench.ngl")}</span>
                <input value={ppl.gpuLayers} onChange={(e) => onPpl("gpuLayers", e.target.value)} placeholder="auto / all / 99" className={`${inputCls} w-24`} />
                <span className={labelCls}>{t("bench.fa")}</span>
                <select value={ppl.flashAttention} onChange={(e) => onPpl("flashAttention", e.target.value)} className={`${selectCls} w-24`}>
                  <option value="auto">{t("common.auto")}</option>
                  <option value="on">{t("common.on")}</option>
                  <option value="off">{t("common.off")}</option>
                </select>
                <span className={labelCls}>{t("bench.cacheK")}</span>
                <input value={ppl.cacheTypeK} onChange={(e) => onPpl("cacheTypeK", e.target.value)} className={`${inputCls} w-20`} />
                <span className={labelCls}>{t("bench.cacheV")}</span>
                <input value={ppl.cacheTypeV} onChange={(e) => onPpl("cacheTypeV", e.target.value)} className={`${inputCls} w-20`} />
                <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
                  <input type="checkbox" className="checkbox checkbox-xs border-line-strong" checked={ppl.mmap} onChange={(e) => onPpl("mmap", e.target.checked)} /> mmap
                </label>
              </div>
              <div className="flex gap-3 text-xs items-center flex-wrap">
                <span className={labelCls}>{t("bench.chunks")}</span>
                <input value={ppl.chunks} onChange={(e) => onPpl("chunks", e.target.value)} className={`${inputCls} w-20`} />
                <span className={labelCls}>{t("bench.pplStride")}</span>
                <input value={ppl.pplStride} onChange={(e) => onPpl("pplStride", e.target.value)} className={`${inputCls} w-20`} />
                <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
                  <input type="checkbox" className="checkbox checkbox-xs border-line-strong" checked={ppl.warmup} onChange={(e) => onPpl("warmup", e.target.checked)} /> {t("bench.warmup")}
                </label>
              </div>
            </>
          )}
          <div className="flex gap-2 text-xs items-center flex-wrap">
            <span className={labelCls}>{t("bench.dataFile")}</span>
            <button onClick={fetchWikitext} disabled={wikiBusy} className="btn btn-primary btn-xs">
              {wikiBusy ? t("bench.downloading") : "WikiText-2"}
            </button>
            <button onClick={pickDataFile} className={secondaryBtn}>{t("common.browse")}</button>
            {promptFile && (
              <span className="text-[11px] text-fg-muted truncate max-w-[280px]" title={promptFile}>
                {promptFile.split(/[\\/]/).pop()}
              </span>
            )}
          </div>
          {wikiNote && <div className="text-[11px] text-fg-muted">{wikiNote}</div>}
        </div>
      )}

      {/* command preview */}
      <CommandPreview open={cmdOpen} onToggle={() => setCmdOpen((o) => !o)} title={t("bench.command")} warnings={result.excluded.length} text={result.command || "—"}>
        {result.excluded.map((x) => (
          <span key={x.label + x.reason} className="text-[11px] text-yellow" title={`${x.label}: ${x.reason}`}>
            <i className="fa-solid fa-triangle-exclamation mr-1" aria-hidden />{x.label}
          </span>
        ))}
        {result.error && (
          <div role="alert" className="alert alert-soft alert-error">
            {result.error}
          </div>
        )}
      </CommandPreview>

      {error && (
        <div role="alert" className="alert alert-soft alert-error">
          {error}
        </div>
      )}

      {/* output terminal */}
      {(running || logs.length > 0) && (
        <pre ref={logRef} className={`min-h-[120px] max-h-72 overflow-y-auto px-3 py-2 text-[11px] leading-relaxed text-fg-muted font-mono ${running ? "border-b border-line" : ""}`}>
          {liveText}
        </pre>
      )}

      {/* FR5.3 — run history comparison */}
      <div className="border-t border-line bg-surface p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-bright">{t("bench.historyTitle")}</span>
          {history.length > 0 && (
            <button onClick={clearHistory} className={ghostBtnMuted}>{t("common.clear")}</button>
          )}
        </div>
        {history.length === 0 ? (
          <div className="text-xs text-fg-faint">{t("bench.historyEmpty")}</div>
        ) : (
          <table className="table text-[11px] font-mono">
            <thead>
              <tr className="text-left text-fg-muted border-b border-line">
                <th className="py-1 pr-2 font-normal">{t("bench.colTime")}</th>
                <th className="py-1 pr-2 font-normal">{t("bench.colTool")}</th>
                <th className="py-1 pr-2 font-normal">{t("bench.colModel")}</th>
                <th className="py-1 pr-2 font-normal">{t("bench.colDuration")}</th>
                <th className="py-1 pr-2 font-normal">t/s</th>
                <th className="py-1 font-normal">{t("bench.colExit")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={`${h.started_at_ms}-${h.tool}`} className="border-b border-line text-fg-muted">
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtClock(h.started_at_ms, settings?.use_24h)}</td>
                  <td className="py-1 pr-2">{h.tool.replace("llama-", "")}</td>
                  <td className="py-1 pr-2 max-w-[180px] truncate" title={h.model}>{modelDisplayName(h.model_path, settings?.model_aliases, h.model)}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtDuration(h.duration_ms)}</td>
                  <td className="py-1 pr-2 text-green">
                    {h.tool.includes("perplexity") && h.ppl != null
                      ? `PPL ${h.ppl}`
                      : h.ts_values.length
                        ? Array.from(new Set(h.ts_values)).join(" / ")
                        : "—"}
                  </td>
                  <td className="py-1">
                    {h.exit_code === 0 || h.exit_code === null ? (
                      <i className="fa-solid fa-check text-green" aria-hidden />
                    ) : (
                      `code ${h.exit_code}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>

      {/* run controls — pinned bottom-right like Quick Launch */}
      <div className="shrink-0 flex items-center gap-2 border-t border-line bg-surface px-3 py-2">
        {running && (
          <span className="text-xs text-fg-muted">
            {t("bench.runningStatus", { pid: running.pid, dur: fmtDuration(elapsedMs) })}
          </span>
        )}
        {(liveTs.length > 0 || livePpl != null) && running && (
          <span className="text-[11px] text-green font-mono">
            {liveTs.length > 0 ? `t/s: ${Array.from(new Set(liveTs)).join(" / ")}` : ""}
            {livePpl != null ? ` PPL: ${livePpl}` : ""}
          </span>
        )}
        <div className="flex-1" />
        {!running ? (
          <div className="tooltip tooltip-top">
            <div className="tooltip-content">{result.error ?? ""}</div>
            <button onClick={run} disabled={!canRun} className="btn btn-xs btn-primary">
              <i className="fa-solid fa-play" aria-hidden />
              {benchmarkType === "bench" ? t("bench.runBenchmark") : t("bench.runPpl")}
            </button>
          </div>
        ) : (
          <button onClick={stop} className="btn btn-xs btn-soft btn-error">
            <i className="fa-solid fa-stop" aria-hidden />
            {t("bench.stop")}
          </button>
        )}
      </div>
    </div>
  );
}
