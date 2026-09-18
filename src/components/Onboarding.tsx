import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getOnboardingData,
  hfGetDownloadStatus,
  hfStartDownload,
  installBuild,
  listLocalModels,
  validateCustomEngine,
} from "../lib/api";
import type { HfDownloadState } from "../lib/api";
import type { BuildAsset, OnboardingData } from "../types";
import { saveSettingsMerged } from "../lib/settings-save";
import { useT } from "../i18n";
import type { EnKey } from "../i18n/en";
import Progress from "./Progress";
import { inputCls } from "../lib/ui";
import { isMac } from "../lib/platform";

const fmtMb = (n: number) => (n / 1_048_576).toFixed(1);

function backendBadge(backend: string) {
  if (backend.startsWith("cuda"))
    return <span className="badge badge-sm badge-success badge-soft">CUDA</span>;
  if (backend === "vulkan")
    return <span className="badge badge-sm badge-accent badge-soft">Vulkan</span>;
  if (backend === "sycl")
    return <span className="badge badge-sm badge-info badge-soft">SYCL</span>;
  if (backend === "metal")
    return <span className="badge badge-sm badge-secondary badge-soft">Metal</span>;
  return <span className="badge badge-sm badge-soft">CPU</span>;
}

interface BuildProgress {
  backend: string;
  phase: "downloading" | "verifying" | "extracting";
  received: number;
  total: number | null;
  file: string;
}

/// Curated starter models for the second onboarding step. Filenames verified
/// against each repo's main branch (Q4_K_M single-file GGUFs).
interface Starter {
  id: string;
  name: string;
  repoId: string;
  file: string;
  approxMb: number;
  minRamGb: number;
  descKey: EnKey;
}

const STARTERS: Starter[] = [
  {
    id: "qwen-3.5-0.8b",
    name: "Qwen3.5-0.8B",
    repoId: "bartowski/Qwen_Qwen3.5-0.8B-GGUF",
    file: "Qwen_Qwen3.5-0.8B-Q4_K_M.gguf",
    approxMb: 553,
    minRamGb: 4,
    descKey: "ob.starter.qwen08",
  },
  {
    id: "qwen-3.5-2b",
    name: "Qwen3.5-2B",
    repoId: "unsloth/Qwen3.5-2B-GGUF",
    file: "Qwen3.5-2B-Q4_K_M.gguf",
    approxMb: 1221,
    minRamGb: 4,
    descKey: "ob.starter.qwen2b",
  },
  {
    id: "qwen-3.5-4b",
    name: "Qwen3.5-4B",
    repoId: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    approxMb: 2612,
    minRamGb: 8,
    descKey: "ob.starter.qwen4b",
  },
  {
    id: "gemma-4-e2b",
    name: "Gemma 4 E2B",
    repoId: "unsloth/gemma-4-E2B-it-GGUF",
    file: "gemma-4-E2B-it-Q4_K_M.gguf",
    approxMb: 2965,
    minRamGb: 8,
    descKey: "ob.starter.gemma4e2b",
  },
];

type Step = "engine" | "model";

/** Hardware summary card — the engine step additionally shows the CPU row. */
function HardwareCard({ data, gpus, showCpu = false }: { data: OnboardingData; gpus: string[]; showCpu?: boolean }) {
  const t = useT();
  return (
    <div className="card card-border mb-4 p-3 bg-raised text-xs space-y-1">
      <div className="font-semibold text-fg-bright mb-2">{t("ob.hardwareTitle")}</div>
      {showCpu && (
        <div><span className="text-fg-muted">{t("ob.cpu")}</span>{data.hardware.cpu_name}</div>
      )}
      <div><span className="text-fg-muted">{t("ob.ram")}</span>{data.hardware.ram_gb} GB</div>
      <div>
        <span className="text-fg-muted">{t("ob.gpu")}</span>
        {gpus.length ? gpus.join("、") : t("ob.noGpu")}
      </div>
    </div>
  );
}

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [step, setStep] = useState<Step>("engine");
  const [data, setData] = useState<OnboardingData | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [customPath, setCustomPath] = useState("");
  const [customBusy, setCustomBusy] = useState(false);

  // starter-model download (shared app-wide HF slot — same state ModelsView uses)
  const [dl, setDl] = useState<HfDownloadState | null>(null);
  const [localCount, setLocalCount] = useState<number | null>(null);

  useEffect(() => {
    getOnboardingData().then(setData).catch((e) => setError(String(e)));
    // progress events (registered once)
    const un = listen<{ phase?: string; received: number; total: number | null; file?: string }>(
      "build-download-progress",
      (e) => {
        setProgress((p) => ({
          backend: p?.backend ?? "",
          phase: (e.payload.phase as BuildProgress["phase"]) ?? "downloading",
          received: e.payload.received,
          total: e.payload.total ?? p?.total ?? null,
          file: e.payload.file ?? p?.file ?? "",
        }));
      },
    );
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    hfGetDownloadStatus().then(setDl).catch(() => {});
    const un = listen<HfDownloadState>("hf-download-progress", (e) => setDl(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (step !== "model") return;
    // vision projector files don't count as models
    listLocalModels().then((l) => setLocalCount(l.filter((f) => !/mmproj/i.test(f.rel_path)).length)).catch(() => {});
  }, [step]);

  const install = async (b: BuildAsset) => {
    setError("");
    setProgress({ backend: b.backend, phase: "downloading", received: 0, total: null, file: "" });
    try {
      await installBuild(b.tag, b.backend);
      setStep("model");
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  };

  const useCustom = async () => {
    if (!customPath.trim()) return;
    setError("");
    setCustomBusy(true);
    try {
      // probe the exe first so a broken path never becomes the active engine;
      // accepts either the .exe or its folder (resolved server-side)
      const res = await validateCustomEngine(customPath.trim());
      await saveSettingsMerged(() => ({ engine_exe: res.path }));
      setStep("model");
    } catch (e) {
      setError(String(e));
    } finally {
      setCustomBusy(false);
    }
  };

  const startStarter = async (s: Starter) => {
    setError("");
    try {
      await hfStartDownload(s.repoId, "main", s.file, null);
    } catch (e) {
      setError(String(e));
    }
  };

  const hw = data?.hardware;
  const gpus = [
    ...(hw?.nvidia_gpus ?? []).map((g) => `${g.name}${g.vram_mb ? ` (${Math.round(g.vram_mb / 1024)} GB VRAM)` : ""}`),
    ...(hw?.other_gpus ?? []),
  ];

  // starter-model fit hints from detected hardware
  const ramGb = hw?.ram_gb ?? 0;
  const vramMb = Math.max(0, ...(hw?.nvidia_gpus ?? []).map((g) => g.vram_mb ?? 0));
  const fitting = STARTERS.filter((s) => s.minRamGb <= ramGb);
  const recommendedId = fitting.length
    ? fitting.reduce((a, b) => (b.approxMb > a.approxMb ? b : a)).id
    : null;
  const dlBusy = !!dl && ["starting", "downloading", "cancelling"].includes(dl.status);

  return (
    <div className="h-full flex flex-col bg-base text-fg">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 pb-4">
          <h1 className="text-2xl font-bold mb-3"><img src="/logo.png" alt="" className="app-logo mr-2" />ChaChaanTeng</h1>
          <p className="text-fg-muted text-xs mb-2">
            {t("ob.subtitle")}
          </p>
          <div className="text-xs text-fg-muted mb-4">
            {step === "engine" ? t("ob.stepEngine") : t("ob.stepModel")}
          </div>

          {error && (
            <div className="alert alert-soft alert-error mb-3 text-sm">
              {error}
            </div>
          )}

          {!data ? (
            <div className="text-fg-faint">{t("ob.detecting")}</div>
          ) : step === "engine" ? (
            <>
              <HardwareCard data={data} gpus={gpus} showCpu />

              {/* Build list */}
              <h2 className="mb-2 text-xs">
                {t("ob.buildsTitle", { tag: data.latest_tag })}
              </h2>
              <div className="space-y-2 mb-4">
                {[...data.builds]
                  .sort((a, b) => Number(b.recommended) - Number(a.recommended))
                  .map((b) => {
                  const isInstalling = progress?.backend === b.backend;
                  // downloading: bytes; verifying: full bar; extracting: file counts
                  const pct =
                    isInstalling && (progress!.total ?? 0) > 0
                      ? Math.round((progress!.received / (progress!.total as number)) * 100)
                      : null;
                  return (
                    <div
                      key={b.backend}
                      className={`card card-border px-3 py-2 flex flex-row items-center gap-1 ${
                        b.recommended
                          ? "bg-accent-subtle border-accent-border"
                          : "bg-surface border-line"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          {backendBadge(b.backend)}
                          <span className="text-xs font-medium">{b.label}</span>
                          <span className="text-xs text-fg-muted">{b.size_mb} MB</span>
                          {b.sha256 ? (
                            <span className="text-xs text-green" title={b.sha256}><i className="fa-solid fa-check mr-1" aria-hidden />SHA256</span>
                          ) : (
                            <span className="text-xs text-fg-faint">{t("ob.noChecksum")}</span>
                          )}
                          {b.recommended && (
                            <span className="badge badge-xs badge-soft badge-warning font-semibold">
                              <i className="fa-solid fa-star" aria-hidden />
                              {t("ob.recommended")}
                            </span>
                          )}
                        </div>
                      </div>
                      {isInstalling ? (
                        <div className="w-60 shrink-0">
                          <Progress value={pct} />
                          <div className="text-xs text-fg-muted mt-1">
                            {progress!.phase === "downloading" && (
                              <>
                                {fmtMb(progress!.received)} MB
                                {(progress!.total ?? 0) > 0 ? ` / ${fmtMb(progress!.total as number)} MB` : ""}
                                {pct !== null ? ` · ${pct}%` : t("ob.downloadingSuffix")}
                              </>
                            )}
                            {progress!.phase === "verifying" && t("ob.verifying")}
                            {progress!.phase === "extracting" && (
                              <>{t("ob.extracting")}{(progress!.total ?? 0) > 0 ? ` · ${pct}%` : ""}</>
                            )}
                          </div>
                          {progress!.file && (
                            <div className="text-[10px] text-fg-faint truncate">{progress!.file}</div>
                          )}
                        </div>
                      ) : (
                        <button onClick={() => install(b)} disabled={progress !== null} className="btn btn-xs btn-primary shrink-0">
                          {t("common.download")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Fallback */}
              <details className="card card-border p-3 bg-raised text-sm">
                <summary className="cursor-pointer text-fg-bright font-medium">
                  {t("ob.customSummary")}
                </summary>
                <div className="mt-3 flex gap-2">
                  <input
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    placeholder={t(isMac() ? "ob.customPhMac" : "ob.customPh")}
                    className={`${inputCls} flex-1`}
                  />
                  <button
                    onClick={async () => {
                      const r = await open({ kind: "directory", multiple: false, title: t("ob.pickFolderTitle") });
                      if (typeof r === "string") setCustomPath(r);
                    }}
                    className="btn btn-xs"
                  >
                    {t("common.browse")}
                  </button>
                  <button onClick={useCustom} disabled={!customPath.trim() || customBusy} className="btn btn-xs">
                    {customBusy ? t("ob.validating") : t("ob.usePath")}
                  </button>
                </div>
              </details>
            </>
          ) : (
            <>
              {/* Starter-model step */}
              <HardwareCard data={data} gpus={gpus} />

              <h2 className="mb-1">{t("ob.modelTitle")}</h2>
              <p className="text-fg-muted text-xs mb-3">
                {t("ob.modelSub")}
              </p>

              {(localCount ?? 0) > 0 && (
                <div className="alert alert-soft mb-4 text-sm">
                  {t("ob.alreadyHaveModels", { n: localCount ?? 0 })}
                </div>
              )}

              {dl?.status === "done" && (
                <div className="alert alert-soft alert-success mb-4 text-sm">
                  {t("ob.modelDone")}
                </div>
              )}
              {dl?.status === "error" && (
                <div className="alert alert-soft alert-error mb-3 text-sm">
                  {dl.message || t("ob.dlError")}
                </div>
              )}

              <div className="space-y-2 mb-4">
                {[...STARTERS]
                  .sort((a, b) => Number(b.id === recommendedId) - Number(a.id === recommendedId))
                  .map((s) => {
                  const isThis = dlBusy && dl!.current_file.includes(s.file);
                  const pct =
                    isThis && (dl!.total ?? 0) > 0
                      ? Math.round(((dl!.downloaded ?? 0) / (dl!.total as number)) * 100)
                      : null;
                  return (
                    <div
                      key={s.id}
                      className={`card card-border px-3 py-2 flex flex-row items-center gap-1 ${
                        s.id === recommendedId
                          ? "bg-accent-subtle border-accent-border"
                          : "bg-surface border-line"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <span className="text-xs font-medium">{s.name}</span>
                          <span className="text-xs text-fg-muted">Q4_K_M · {s.approxMb} MB</span>
                          {vramMb >= s.approxMb * 1.5 && (
                            <span className="badge badge-xs badge-soft badge-success">{t("ob.fitsVram")}</span>
                          )}
                          {s.minRamGb > ramGb && (
                            <span className="badge badge-xs badge-soft badge-warning">{t("ob.needsMoreMem")}</span>
                          )}
                          {s.id === recommendedId && (
                            <span className="badge badge-xs badge-soft badge-warning font-semibold">
                              <i className="fa-solid fa-star" aria-hidden />
                              {t("ob.recommended")}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-fg-muted mt-0.5">{t(s.descKey)}</div>
                      </div>
                      {isThis ? (
                        <div className="w-60 shrink-0">
                          <Progress value={pct} />
                          <div className="text-xs text-fg-muted mt-1">
                            {fmtMb(dl!.downloaded ?? 0)} MB
                            {(dl!.total ?? 0) > 0 ? ` / ${fmtMb(dl!.total as number)} MB` : ""}
                            {pct !== null ? ` · ${pct}%` : t("ob.downloadingSuffix")}
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => startStarter(s)} disabled={dlBusy} className="btn btn-xs btn-primary shrink-0">
                          {t("common.download")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* sticky footer — same pattern as the Settings page: actions always visible while content scrolls */}
      <div className="flex shrink-0 items-center justify-between border-t border-line bg-surface px-6 py-2">
        {step === "model" ? (
          <button onClick={() => setStep("engine")} disabled={dlBusy || progress !== null} className="btn btn-ghost btn-xs text-fg-muted">
            {t("ob.back")}
          </button>
        ) : (
          <span />
        )}
        {step === "engine" ? (
          <div className="flex gap-2">
            {/* skip only this step → go to the starter-model step without installing an engine */}
            <button onClick={() => setStep("model")} disabled={dlBusy || progress !== null} className="btn btn-ghost btn-xs text-fg-muted">
              {t("ob.skipStep")}
            </button>
            {/* skip everything → enter the app; onboarding reappears next launch until an engine exists */}
            <button onClick={onDone} disabled={dlBusy || progress !== null} className="btn btn-ghost btn-xs text-fg-muted">
              {t("ob.skipAll")}
            </button>
          </div>
        ) : dl?.status === "done" ? (
          <button onClick={onDone} className="btn btn-primary btn-xs">
            {t("ob.enterApp")}
          </button>
        ) : (
          <button onClick={onDone} disabled={dlBusy || progress !== null} className="btn btn-ghost btn-xs text-fg-muted">
            {t("ob.skipStep")}
          </button>
        )}
      </div>
    </div>
  );
}
