import { useEffect, useState } from "react";
import Onboarding from "./components/Onboarding";
import ChatView from "./components/ChatView";
import QuickLaunchView from "./components/QuickLaunchView";
import ConfigureView from "./components/ConfigureView";
import SettingsView from "./components/SettingsView";
import ModelsView from "./components/ModelsView";
import BenchmarksView from "./components/BenchmarksView";
import MonitorView from "./components/MonitorView";
import ServerLogsView from "./components/ServerLogsView";
import SidebarServerCard from "./components/SidebarServerCard";
import TitleBar, { ResizeHandles } from "./components/TitleBar";
import { getSettings, listInstalledEngines } from "./lib/api";
import { ensureBenchEvents } from "./lib/bench-events";
import { ensureMonitorSync } from "./lib/monitor-sync";
import { ensureLogSync } from "./lib/server-log-sync";
import { ensureServerEvents } from "./lib/server-events";
import { useFlags } from "./store-flags";
import { useScopes } from "./store-scopes";
import { useApp } from "./store";
import { useT } from "./i18n";

/** Sync the flag-core binary gate (e.g. native --reasoning-effort on b10434+) with the active engine. */
function syncBinaryTag(engines: { path: string; version: string | null }[], preferred?: string | null) {
  const eng = engines.find((e) => e.path === preferred) ?? engines[0];
  useFlags.getState().setBinaryTag(eng ? (eng.version ?? "custom") : "");
}

type Tab = "chat" | "quicklaunch" | "logs" | "models" | "benchmarks" | "monitor" | "configure" | "settings";

function tabCls(active: boolean) {
  return `btn btn-sm w-full justify-start gap-2 shadow-none border ${
    active
      ? "bg-accent-subtle text-accent-text border-transparent font-medium"
      : "border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg-bright"
  }`;
}

export default function App() {
  const [phase, setPhase] = useState<"loading" | "onboarding" | "main">("loading");
  const [tab, setTab] = useState<Tab>("chat");
  const { settings, engines, setSettings, setEngines } = useApp();
  const t = useT();

  const load = async () => {
    const [s, e] = await Promise.all([getSettings(), listInstalledEngines()]);
    setSettings(s);
    setEngines(e);
    syncBinaryTag(e, s.engine_exe);
    return { s, e };
  };

  useEffect(() => {
    // App-lifetime event routing (must outlive view unmounts).
    ensureServerEvents();
    ensureBenchEvents();
    ensureLogSync();
    ensureMonitorSync();
    (async () => {
      // Phase G — load persisted flag scopes in parallel with settings/engines
      void useScopes.getState().load();
      try {
        const { s, e } = await load();
        setPhase(e.length > 0 || s.engine_exe ? "main" : "onboarding");
      } catch {
        setPhase("onboarding");
      }
    })();
  }, [setSettings, setEngines]);

  const onOnboarded = async () => {
    try {
      await load();
    } catch {
      // ignore — still go to main
    }
    setPhase("main");
  };

  if (phase === "loading") {
    return (
      <div className="relative h-screen flex flex-col bg-base text-fg">
        <TitleBar />
        <ResizeHandles />
        <div className="flex-1 flex items-center justify-center text-fg-faint">{t("app.loading")}</div>
      </div>
    );
  }

  if (phase === "onboarding") {
    return (
      <div className="relative h-screen flex flex-col bg-base">
        <TitleBar />
        <ResizeHandles />
        <div className="flex-1 min-h-0 overflow-hidden">
          <Onboarding onDone={onOnboarded} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-screen flex flex-col bg-base text-fg">
      <TitleBar />
      <ResizeHandles />
      <div className="flex-1 min-h-0 flex">
        <aside className="w-48 shrink-0 border-r border-line bg-surface p-3 flex flex-col gap-1">
          <button onClick={() => setTab("chat")} className={tabCls(tab === "chat")}>
            <i className="fa-solid fa-comment-dots" aria-hidden /> {t("tab.chat")}
          </button>
          <button onClick={() => setTab("quicklaunch")} className={tabCls(tab === "quicklaunch")}>
            <i className="fa-solid fa-rocket" aria-hidden /> {t("tab.quicklaunch")}
          </button>
          <button onClick={() => setTab("logs")} className={tabCls(tab === "logs")}>
            <i className="fa-solid fa-scroll" aria-hidden /> {t("tab.logs")}
          </button>
          <button onClick={() => setTab("configure")} className={tabCls(tab === "configure")}>
            <i className="fa-solid fa-sliders" aria-hidden /> {t("tab.configure")}
          </button>
          <button onClick={() => setTab("models")} className={tabCls(tab === "models")}>
            <i className="fa-solid fa-box" aria-hidden /> {t("tab.models")}
          </button>
          <button onClick={() => setTab("benchmarks")} className={tabCls(tab === "benchmarks")}>
            <i className="fa-solid fa-chart-column" aria-hidden /> {t("tab.benchmarks")}
          </button>
          <button onClick={() => setTab("monitor")} className={tabCls(tab === "monitor")}>
            <i className="fa-solid fa-desktop" aria-hidden /> {t("tab.monitor")}
          </button>
          <button onClick={() => setTab("settings")} className={tabCls(tab === "settings")}>
            <i className="fa-solid fa-gear" aria-hidden /> {t("tab.settings")}
          </button>
          {/* Live per-server cards — pinned to the bottom of the menu, visible from any page */}
          <div className="flex-1" />
          <SidebarServerCard />
        </aside>
        {/* All views stay mounted — tab switching only hides them, so view-local state (drafts,
            scroll position, in-flight UI) survives page switches like real desktop tabs. Each
            view gates its polling and window listeners on `active` so hidden pages do no work. */}
        <main className="flex-1 overflow-hidden bg-base">
          <div className={tab === "chat" ? "h-full" : "hidden"}>
            <ChatView visible={tab === "chat"} />
          </div>
          <div className={tab === "quicklaunch" ? "h-full" : "hidden"}>
            <QuickLaunchView visible={tab === "quicklaunch"} />
          </div>
          <div className={tab === "logs" ? "h-full" : "hidden"}>
            <ServerLogsView visible={tab === "logs"} />
          </div>
          <div className={tab === "models" ? "h-full" : "hidden"}>
            <ModelsView visible={tab === "models"} />
          </div>
          <div className={tab === "benchmarks" ? "h-full" : "hidden"}>
            <BenchmarksView visible={tab === "benchmarks"} />
          </div>
          <div className={tab === "monitor" ? "h-full" : "hidden"}>
            <MonitorView visible={tab === "monitor"} />
          </div>
          <div className={tab === "configure" ? "h-full" : "hidden"}>
            <ConfigureView visible={tab === "configure"} />
          </div>
          <div className={tab === "settings" ? "h-full" : "hidden"}>
            <SettingsView visible={tab === "settings"} />
          </div>
        </main>
      </div>
    </div>
  );
}
