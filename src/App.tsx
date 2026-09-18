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
import TitleBar, { ResizeHandles, TitleControls } from "./components/TitleBar";
import { isMac } from "./lib/platform";
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

/** Sidebar order; the main area renders views in this same order (hidden ones are display:none,
    so DOM order has no visual effect). */
const TABS = [
  { id: "chat", icon: "fa-comment-dots", View: ChatView },
  { id: "quicklaunch", icon: "fa-rocket", View: QuickLaunchView },
  { id: "logs", icon: "fa-scroll", View: ServerLogsView },
  { id: "configure", icon: "fa-sliders", View: ConfigureView },
  { id: "models", icon: "fa-box", View: ModelsView },
  { id: "benchmarks", icon: "fa-chart-column", View: BenchmarksView },
  { id: "monitor", icon: "fa-desktop", View: MonitorView },
  { id: "settings", icon: "fa-gear", View: SettingsView },
] as const;

type Tab = (typeof TABS)[number]["id"];

function tabCls(active: boolean) {
  return `btn btn-xs w-full justify-start gap-2 shadow-none border ${
    active
      ? "bg-accent-subtle text-accent-text border-transparent font-medium"
      : "border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg-bright"
  }`;
}

export default function App() {
  const [phase, setPhase] = useState<"loading" | "onboarding" | "main">("loading");
  const [tab, setTab] = useState<Tab>("chat");
  const { setSettings, setEngines } = useApp();
  const t = useT();
  const mac = isMac();

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
        {!mac && <TitleBar />}
        <ResizeHandles />
        <div className="flex-1 flex items-center justify-center text-fg-faint">{t("app.loading")}</div>
      </div>
    );
  }

  if (phase === "onboarding") {
    return (
      <div className="relative h-screen flex flex-col bg-base">
        {!mac && <TitleBar />}
        <ResizeHandles />
        <div className="flex-1 min-h-0 overflow-hidden">
          <Onboarding onDone={onOnboarded} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-screen flex flex-col bg-base text-fg">
      {!mac && <TitleBar />}
      <ResizeHandles />
      <div className="flex-1 min-h-0 flex">
        <aside className={`w-48 shrink-0 border-r border-line bg-surface px-3 pb-3 pt-2 flex flex-col gap-1`}>
          {TABS.map((x) => (
            <button key={x.id} onClick={() => setTab(x.id)} className={tabCls(tab === x.id)}>
              <i className={`fa-solid ${x.icon}`} aria-hidden /> {t(`tab.${x.id}`)}
            </button>
          ))}
          {/* Live per-server cards — pinned to the bottom of the menu, visible from any page */}
          <div className="flex-1" />
          <SidebarServerCard />
          {/* macOS: theme + language live here instead of in a title bar (menu opens upward) */}
          {mac && (
            <div className="mt-2 pt-2 border-t border-line">
              <TitleControls up />
            </div>
          )}
        </aside>
        {/* All views stay mounted — tab switching only hides them, so view-local state (drafts,
            scroll position, in-flight UI) survives page switches like real desktop tabs. Each
            view gates its polling and window listeners on `visible` so hidden pages do no work. */}
        <main className="flex-1 overflow-hidden bg-base">
          {TABS.map((x) => (
            <div key={x.id} className={tab === x.id ? "h-full" : "hidden"}>
              <x.View visible={tab === x.id} />
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
