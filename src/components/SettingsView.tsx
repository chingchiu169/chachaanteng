import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, message } from "@tauri-apps/plugin-dialog";
import {
  getModelsDirInfo,
  getSettings,
  saveSettings,
  tunnelStatus,
  tunnelStart,
  tunnelStop,
  gitUpdateStatus,
  gitPull,
  restartApp,
  installBuild,
  listInstalledEngines,
  deleteInstalledEngine,
  listEngineVersions,
} from "../lib/api";
import type { TunnelSnapshot, GitStatus, GitPullResult, EngineVersion } from "../lib/api";
import type { EngineInfo } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import ExtServersPanel from "./ExtServersPanel";
import Progress from "./Progress";
import { basePort, useScopes } from "../store-scopes";
import { useApp } from "../store";
import { useI18n, useT } from "../i18n";
import type { EnKey } from "../i18n/en";
import { useThemeMode, type Mode } from "../lib/themes";
import { inputCls, raisedBtn, selectCls } from "../lib/ui";

const TUNNEL_ACTIVE = ["preparing", "downloading", "starting", "running"];

type SettingsTab = "general" | "engine" | "integrations" | "external";
const SETTINGS_TABS: { id: SettingsTab; label: EnKey }[] = [
  { id: "general", label: "settings.tabGeneral" },
  { id: "engine", label: "settings.tabEngine" },
  { id: "integrations", label: "settings.tabIntegrations" },
  { id: "external", label: "settings.tabExternal" },
];

export default function SettingsView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const { settings, engines, setSettings, setEngines } = useApp();
  const [engineExe, setEngineExe] = useState("");
  /** Effective models root (app default until the user picks another folder). */
  const [modelsDir, setModelsDir] = useState("");
  const [searxngUrl, setSearxngUrl] = useState("");
  const [use24h, setUse24h] = useState(false);
  /** Server log retention in days (0 = keep everything) — pruned at app start. */
  const [logRetention, setLogRetention] = useState(0);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");

  // language + theme live in their own stores (shared with the title bar) — not settings.json
  const { lang, setLang } = useI18n();
  const { mode, setMode } = useThemeMode();

  // FR8.1 — Cloudflare tunnel
  const [tun, setTun] = useState<TunnelSnapshot | null>(null);
  const [tunPort, setTunPort] = useState(8080);
  const tunActive = !!tun && TUNNEL_ACTIVE.includes(tun.status);

  // FR8.2 — git update (dev installs only)
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitErr, setGitErr] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<GitPullResult | null>(null);

  // Engine tab — version download + installed engines
  const [versions, setVersions] = useState<EngineVersion[]>([]);
  const [selTag, setSelTag] = useState("");
  const [selBackend, setSelBackend] = useState("cpu");
  const [installing, setInstalling] = useState(false);
  const [buildProg, setBuildProg] = useState<{ phase: string; received: number; total: number | null; file?: string } | null>(null);
  const [engErr, setEngErr] = useState("");
  const [installed, setInstalled] = useState<EngineInfo[]>([]);
  const [delTarget, setDelTarget] = useState<EngineInfo | null>(null);

  // which copy button just fired ("pub" / "api") — shows ✓ briefly
  const [copied, setCopied] = useState("");

  // The tunnel port starts from the Configure `port` flag — but that read races the scopes load
  // (basePort() returns the default until then), so re-derive once when it lands. A user edit in
  // between wins: the ref below suppresses the re-sync.
  const tunPortEdited = useRef(false);
  const scopesLoaded = useScopes((s) => s.loaded);
  useEffect(() => {
    if (scopesLoaded && !tunPortEdited.current) setTunPort(basePort());
  }, [scopesLoaded]);

  // Sync drafts from the store — but ONLY fields whose stored value actually changed, so an
  // unrelated settings update (e.g. switching the active engine) can't wipe unsaved edits.
  const prevSettings = useRef<typeof settings>(null);
  useEffect(() => {
    if (!settings) return;
    const prev = prevSettings.current;
    prevSettings.current = settings;
    if (prev === null) {
      // first load — fill everything; tunnel port starts from the Configure `port` flag
      setEngineExe(settings.engine_exe ?? "");
      setSearxngUrl(settings.searxng_url ?? "");
      setUse24h(!!settings.use_24h);
      setLogRetention(settings.log_retention_days ?? 0);
      setTunPort(basePort());
      return;
    }
    if (settings.engine_exe !== prev.engine_exe) setEngineExe(settings.engine_exe ?? "");
    if ((settings.searxng_url ?? "") !== (prev.searxng_url ?? "")) setSearxngUrl(settings.searxng_url ?? "");
    if (!!settings.use_24h !== !!prev.use_24h) setUse24h(!!settings.use_24h);
    if ((settings.log_retention_days ?? 0) !== (prev.log_retention_days ?? 0)) setLogRetention(settings.log_retention_days ?? 0);
  }, [settings]);

  // Tunnel: read current status on mount, then poll every 2s while a run is active.
  useEffect(() => {
    let alive = true;
    tunnelStatus()
      .then((s) => alive && setTun(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Gated on `visible` (the view stays mounted on other tabs); the immediate fetch below refreshes
  // status the moment the page is shown again. The tunnel itself keeps running server-side either way.
  useEffect(() => {
    if (!tunActive || !visible) return;
    tunnelStatus().then(setTun).catch(() => {});
    const id = setInterval(() => {
      tunnelStatus().then(setTun).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [tunActive, visible]);

  // Git: check status once on mount (release builds just get a "not a git install" note).
  useEffect(() => {
    let alive = true;
    gitUpdateStatus()
      .then((s) => alive && setGit(s))
      .catch((e) => alive && setGitErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // models root — resolve the effective dir (configured or app default) on mount
  useEffect(() => {
    getModelsDirInfo()
      .then((i) => setModelsDir(i.models_dir))
      .catch(() => {});
  }, []);

  // Engine tab — installed list + downloadable versions (newest first; default = latest)
  useEffect(() => {
    listInstalledEngines().then(setInstalled).catch(() => {});
    listEngineVersions()
      .then((vs) => {
        setVersions(vs);
        if (vs.length > 0) setSelTag(vs[0].tag);
      })
      .catch((e) => setEngErr(String(e)));
  }, []);

  // engine download progress events (shared with onboarding; each keeps its own state)
  useEffect(() => {
    const un = listen<{ phase?: string; received: number; total: number | null; file?: string }>(
      "build-download-progress",
      (e) =>
        setBuildProg({
          phase: e.payload.phase ?? "",
          received: e.payload.received,
          total: e.payload.total,
          file: e.payload.file,
        }),
    );
    return () => {
      un.then((f) => f());
    };
  }, []);

  /** Set an installed engine as the active one — persists immediately (no Save needed). */
  const setActiveEngine = async (path: string) => {
    if (!settings) return;
    setEngineExe(path);
    const next = { ...settings, engine_exe: path };
    setSettings(next);
    await saveSettings(next).catch(() => {});
  };

  /** Delete an installed engine folder; clear the active pointer if it was selected. */
  const doDeleteEngine = async (e: EngineInfo) => {
    setDelTarget(null);
    setEngErr("");
    try {
      await deleteInstalledEngine(e.path);
      const list = await listInstalledEngines();
      setInstalled(list);
      setEngines(list); // keep the app store in sync for other views
      if (settings && settings.engine_exe === e.path) {
        setEngineExe("");
        const next = { ...settings, engine_exe: null };
        setSettings(next);
        await saveSettings(next).catch(() => {});
      }
    } catch (err) {
      setEngErr(String(err));
    }
  };

  /** Download + install a llama.cpp release; adopt it as the active engine on success. */
  const doInstall = async () => {
    if (!selTag || !selBackend) return;
    setInstalling(true);
    setEngErr("");
    setBuildProg(null);
    try {
      const exePath = await installBuild(selTag, selBackend);
      const list = await listInstalledEngines();
      setInstalled(list);
      setEngines(list); // keep the app store in sync for other views
      if (settings) {
        const next = { ...settings, engine_exe: exePath };
        setSettings(next);
        saveSettings(next).catch(() => {});
      }
    } catch (e) {
      setEngErr(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const startTunnel = async () => {
    try {
      setTun(await tunnelStart(tunPort));
    } catch (e) {
      void message(String(e));
    }
  };

  const stopTunnel = async () => {
    try {
      setTun(await tunnelStop());
    } catch (e) {
      void message(String(e));
    }
  };

  const checkGit = async () => {
    setGitErr("");
    setPulled(null);
    try {
      setGit(await gitUpdateStatus());
    } catch (e) {
      setGit(null);
      setGitErr(String(e));
    }
  };

  const doPull = async () => {
    setPulling(true);
    setPulled(null);
    try {
      const r = await gitPull();
      setPulled(r);
      try {
        setGit(await gitUpdateStatus()); // refresh HEAD / behind count
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      void message(String(e));
    } finally {
      setPulling(false);
    }
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 1200);
    } catch {
        /* clipboard unavailable — ignore */
    }
  };

  /** Pick a new models root folder — persisted on Save. */
  const changeModelsDir = async () => {
    const picked = await openFileDialog({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) setModelsDir(picked);
  };

  // Engine select options — prefer locally-installed builds over the bundled engine list.
  const engineOptions = installed.length > 0 ? installed : engines;

  const save = async () => {
    try {
      const s = await getSettings();
      const next = {
        ...s,
        engine_exe: engineExe || null,
        models_dir: modelsDir || null,
        searxng_url: searxngUrl.trim() || null,
        use_24h: use24h,
        log_retention_days: logRetention,
      };
      await saveSettings(next);
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      void message(String(e));
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* category tabs — sections grouped like a settings sidebar, but as a tab bar */}
      <div role="tablist" className="tabs tabs-border shrink-0 border-b border-line bg-surface px-3">
        {SETTINGS_TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={`tab ${tab === x.id ? "tab-active" : ""}`}
          >
            {t(x.label)}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "general" && (
          <>
        {/* Preferences — language, theme, clock format */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.preferences")}</div>
          <div className="flex gap-4 flex-wrap items-center">
            <label className="text-xs text-fg-muted flex items-center gap-1.5">
              {t("settings.language")}
              <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "zh-TW")} className={`${selectCls} w-32`}>
                <option value="en">English</option>
                <option value="zh-TW">繁體中文</option>
              </select>
            </label>
            <label className="text-xs text-fg-muted flex items-center gap-1.5">
              {t("settings.theme")}
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} className={`${selectCls} w-28`}>
                <option value="dark">{t("settings.themeDark")}</option>
                <option value="light">{t("settings.themeLight")}</option>
              </select>
            </label>
            <label className="text-xs text-fg-muted flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" className="checkbox checkbox-xs" checked={use24h} onChange={(e) => setUse24h(e.target.checked)} />
              {t("settings.use24h")}
            </label>
          </div>
        </section>

        {/* Server log retention — pruned at app start */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.logRetention")}</div>
          <p className="text-[11px] text-fg-muted">{t("settings.logRetentionHelp")}</p>
          <select value={logRetention} onChange={(e) => setLogRetention(Number(e.target.value))} className={`${selectCls} w-40`}>
            <option value={0}>{t("settings.retentionNever")}</option>
            <option value={7}>{t("settings.retentionDays", { days: 7 })}</option>
            <option value={30}>{t("settings.retentionDays", { days: 30 })}</option>
            <option value={90}>{t("settings.retentionDays", { days: 90 })}</option>
            <option value={180}>{t("settings.retentionDays", { days: 180 })}</option>
          </select>
        </section>

        {/* Model folder — the models root (HF downloads + local listing) */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.modelsFolder")}</div>
          <p className="text-[11px] text-fg-muted">{t("settings.modelsFolderHelp")}</p>
          <div className="flex items-center gap-2 flex-wrap">
            {modelsDir && (
              <code className="px-2 py-1 rounded bg-raised border border-line text-[11px] max-w-[480px] truncate" title={modelsDir}>
                {modelsDir}
              </code>
            )}
            <button onClick={changeModelsDir} className={raisedBtn}>
              {t("common.change")}
            </button>
          </div>
        </section>
          </>
        )}
        {tab === "engine" && (
          <>
        {/* Current engine — which llama-server.exe the app launches */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.engineSource")}</div>
          {engineOptions.length > 0 && (
            <select value={engineExe} onChange={(e) => setEngineExe(e.target.value)} disabled={installing} className={`${selectCls} w-full`}>
              <option value="">{t("settings.autoEngine")}</option>
              {engineOptions.map((e) => (
                <option key={e.path} value={e.path}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
          <input
            value={engineExe}
            onChange={(e) => setEngineExe(e.target.value)}
            placeholder={t("settings.enginePathPh")}
            className={`${inputCls} w-full`}
          />
        </section>

        {/* Download a specific llama.cpp version */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.engineDownload")}</div>
          <div className="flex gap-3 flex-wrap items-center">
            <label className="text-xs text-fg-muted flex items-center gap-1.5">
              {t("settings.version")}
              <select value={selTag} onChange={(e) => setSelTag(e.target.value)} disabled={installing || versions.length === 0} className={`${selectCls} w-40`}>
                {versions.map((v, i) => (
                  <option key={v.tag} value={v.tag}>
                    {i === 0 ? `${v.tag} (${t("settings.latest")})` : v.tag}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-fg-muted flex items-center gap-1.5">
              {t("settings.backend")}
              <select value={selBackend} onChange={(e) => setSelBackend(e.target.value)} disabled={installing} className={`${selectCls} w-52`}>
                <option value="cpu">CPU</option>
                <option value="cuda-12.4">CUDA 12.4 (NVIDIA)</option>
                <option value="cuda-13.3">CUDA 13.3 (NVIDIA)</option>
                <option value="vulkan">Vulkan (AMD / Intel / NVIDIA)</option>
                <option value="sycl">SYCL (Intel Arc)</option>
              </select>
            </label>
            <button onClick={doInstall} disabled={!selTag || installing} className="btn btn-primary btn-xs">
              {installing ? t("settings.downloading") : t("common.download")}
            </button>
          </div>
          {buildProg && installing && (
            <div className="space-y-1">
              {buildProg.total ? (
                <Progress value={Math.min(100, Math.round((buildProg.received / buildProg.total) * 100))} />
              ) : (
                <Progress />
              )}
              <div className="text-[11px] text-fg-muted font-mono truncate">
                {buildProg.phase}: {buildProg.file ?? ""}
              </div>
            </div>
          )}
          {engErr && !installing && (
            <div role="alert" className="alert alert-error">{engErr}</div>
          )}
        </section>

        {/* Installed engines */}
        <section className="bg-surface p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.installedEngines")}</div>
          {installed.length === 0 ? (
            <div className="text-xs text-fg-faint">{t("settings.noEngines")}</div>
          ) : (
            <ul className="space-y-1">
              {installed.map((e) => {
                const isActive = settings?.engine_exe === e.path;
                return (
                  <li key={e.path} className="flex items-center gap-2 text-xs">
                    <span className={`badge badge-xs badge-soft shrink-0 px-2 ${isActive ? "badge-success" : "badge-ghost"}`}>
                      {e.version ?? "custom"}
                    </span>
                    <span className="truncate flex-1 font-mono text-fg-muted" title={e.path}>{e.name}</span>
                    {isActive ? (
                      <span className="text-[11px] text-green shrink-0"><i className="fa-solid fa-check" aria-hidden /></span>
                    ) : (
                      <button
                        onClick={() => void setActiveEngine(e.path)}
                        className="btn btn-xs border border-line bg-raised hover:bg-hover text-fg-muted shrink-0"
                      >
                        {t("settings.setActive")}
                      </button>
                    )}
                    <button
                      onClick={() => setDelTarget(e)}
                      title={t("settings.deleteEngineTitle")}
                      className="btn btn-xs btn-ghost px-1 min-h-0 text-fg-faint hover:text-red shrink-0"
                    >
                      <i className="fa-solid fa-trash-can" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
          </>
        )}
        {tab === "integrations" && (
          <>
        {/* Web search (FR2.4) */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.webSearch")}</div>
          <label className="text-xs text-fg-muted flex items-center gap-1 w-full">
            {t("settings.searxngLabel")}
            <input
              value={searxngUrl}
              onChange={(e) => setSearxngUrl(e.target.value)}
              placeholder={t("settings.searxngPh")}
              className={`${inputCls} flex-1`}
            />
          </label>
          <p className="text-[11px] text-fg-muted">{t("settings.searxngHelp")}</p>
        </section>

        {/* Cloudflare tunnel (FR8.1) */}
        <section className="bg-surface border-b border-line p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.tunnelTitle")}</div>
          <p className="text-[11px] text-fg-muted">
            {t("settings.tunnelHelp")}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-fg-muted flex items-center gap-1">
              Port
              <input type="number" value={tunPort} onChange={(e) => { tunPortEdited.current = true; setTunPort(Number(e.target.value)); }} className={`${inputCls} w-24`} />
            </label>
            {tunActive ? (
              <button onClick={stopTunnel} className="btn btn-sm btn-soft btn-error">
                <i className="fa-solid fa-stop mr-1.5" aria-hidden />
                {t("settings.stopTunnel")}
              </button>
            ) : (
              <button onClick={startTunnel} disabled={!tunPort} className="btn btn-primary btn-xs">
                <i className="fa-solid fa-play mr-1.5" aria-hidden />
                {t("settings.startTunnel")}
              </button>
            )}
            {tun && tun.status !== "idle" && (
              <span
                className={`badge badge-sm ${
                  tun.status === "running"
                    ? "badge-success"
                    : tun.status === "error"
                      ? "badge-error"
                      : TUNNEL_ACTIVE.includes(tun.status)
                        ? "badge-warning"
                        : ""
                }`}
              >
                {tun.status === "running" ? (
                  <>
                    <i className="fa-solid fa-circle mr-1.5 text-[8px]" aria-hidden />
                    running
                  </>
                ) : (
                  tun.status
                )}
              </span>
            )}
          </div>
          {tun?.message && (
            <p className={`text-[11px] ${tun.status === "error" ? "text-red" : "text-fg-muted"}`}>{tun.message}</p>
          )}
          {tun?.status === "running" && tun.url && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-fg-muted shrink-0">{t("settings.publicUrl")}</span>
                <code className="font-mono text-green break-all flex-1">{tun.url}</code>
                <button onClick={() => copy("pub", tun.url)} className="btn btn-xs shrink-0">
                  {copied === "pub" ? (
                    <i className="fa-solid fa-check text-green" aria-hidden />
                  ) : (
                    t("common.copy")
                  )}
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-fg-muted shrink-0">{t("settings.openaiApi")}</span>
                <code className="font-mono text-green break-all flex-1">{tun.url}/v1</code>
                <button onClick={() => copy("api", `${tun.url}/v1`)} className="btn btn-xs shrink-0">
                  {copied === "api" ? (
                    <i className="fa-solid fa-check text-green" aria-hidden />
                  ) : (
                    t("common.copy")
                  )}
                </button>
              </div>
            </div>
          )}
          {tun && tun.log.length > 0 && (
            <pre className="bg-base border border-line rounded-md p-2 text-[10px] font-mono text-fg-muted max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
              {tun.log.slice(-6).join("\n")}
            </pre>
          )}
        </section>
          </>
        )}
        {/* External servers — CRUD for the saved address book + their stored keys */}
        {tab === "external" && <ExtServersPanel visible={visible} />}

        {/* Git update (FR8.2) — lives in General now that the Developer tab is gone */}
        {tab === "general" && (
          <>
        <section className="bg-surface p-3 space-y-2">
          <div className="text-xs font-medium text-fg-bright">{t("settings.gitTitle")}</div>
          {gitErr && <p className="text-[11px] text-fg-muted">{gitErr}</p>}
          {git && (
            <>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-mono font-medium text-fg-bright">{git.branch}</span>
                <span className="text-fg-muted truncate max-w-[300px]" title={git.head}>
                  {git.head}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {git.behind > 0 ? (
                  <span className="badge badge-sm badge-soft badge-warning">
                    <i className="fa-solid fa-arrow-down mr-1" aria-hidden />
                    {t("settings.behindUpstream", { n: git.behind })}
                  </span>
                ) : (
                  <span className="text-[11px] text-green"><i className="fa-solid fa-check mr-1" aria-hidden />{t("settings.upToDate")}</span>
                )}
                {git.ahead > 0 && (
                  <span className="badge badge-sm badge-soft badge-accent">
                    <i className="fa-solid fa-arrow-up mr-1" aria-hidden />
                    {t("settings.ahead", { n: git.ahead })}
                  </span>
                )}
              </div>
              {git.dirty.length > 0 && (
                <div className="text-[11px] text-yellow">
                  <i className="fa-solid fa-triangle-exclamation mr-1" aria-hidden />
                  {t("settings.dirtyNote", {
                    n: git.dirty.length,
                    list: git.dirty.slice(0, 3).join(", "),
                    more: git.dirty.length > 3 ? ` +${git.dirty.length - 3}` : "",
                  })}
                </div>
              )}
              {git.fetch_note && <p className="text-[11px] text-yellow">{git.fetch_note}</p>}
              <div className="flex gap-2">
                <button onClick={checkGit} className="btn btn-sm">
                  {t("settings.checkUpdate")}
                </button>
                <button
                  onClick={doPull}
                  disabled={pulling || git.behind === 0}
                  className="btn btn-primary btn-xs"
                >
                  {pulling ? t("settings.pulling") : t("settings.pullBtn")}
                </button>
              </div>
              {pulled && (
                <div className="text-[11px] text-green space-y-1.5">
                  <div>
                    <i className="fa-solid fa-check mr-1" aria-hidden />
                    {t("settings.updatedTo", { head: pulled.head })}
                    {pulled.stashed ? t("settings.stashNote") : ""}
                  </div>
                  <button onClick={() => restartApp()} className="btn btn-primary btn-xs">
                    {t("settings.restartNow")}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
          </>
        )}
      </div>

      {/* sticky footer — save is always visible (far right), content scrolls above it */}
      <div className="flex shrink-0 justify-end border-t border-line bg-surface px-3 py-2">
        <button onClick={save} className={`btn btn-sm ${saved ? "btn-success" : "btn-primary"}`}>
          {saved ? (
            <>
              <i className="fa-solid fa-check mr-1.5" aria-hidden />
              {t("settings.saved")}
            </>
          ) : (
            t("common.save")
          )}
        </button>
      </div>

      <ConfirmDialog
        open={delTarget !== null}
        title={t("settings.deleteEngineTitle")}
        message={delTarget ? t("settings.deleteEngineConfirm", { name: delTarget.name }) : ""}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doDeleteEngine(delTarget!)}
        onCancel={() => setDelTarget(null)}
      />
    </div>
  );
}
