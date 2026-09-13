import { useEffect, useState } from "react";
import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useThemeMode } from "../lib/themes";
import { useI18n, useT, type Lang } from "../i18n";

/** Mirrors @tauri-apps/api's ResizeDirection (not re-exported by the package). */
type ResizeDir =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh-TW", label: "繁體中文" },
];

/** Shared maximized state — TitleBar and ResizeHandles both read it, one window listener total. */
const useMaximizedStore = create<{ maximized: boolean; set: (m: boolean) => void }>((set) => ({
  maximized: false,
  set: (maximized) => set({ maximized }),
}));

let trackingStarted = false;
function startMaximizedTracking(): void {
  if (trackingStarted) return;
  trackingStarted = true;
  const win = getCurrentWindow();
  try {
    void win.isMaximized().then((m) => useMaximizedStore.getState().set(m)).catch(() => {});
    void win
      .onResized(() => {
        win.isMaximized().then((m) => useMaximizedStore.getState().set(m)).catch(() => {});
      })
      .catch(() => {});
  } catch {
    /* non-Tauri context (plain browser dev) — leave defaults */
  }
}

/** Tracks whether the window is maximized — drives the max/restore icon and resize-zone visibility. */
function useMaximized(): boolean {
  const maximized = useMaximizedStore((s) => s.maximized);
  useEffect(() => {
    startMaximizedTracking();
  }, []);
  return maximized;
}

/**
 * Custom title bar (the window runs with decorations: false).
 * Left drag region + brand · center mode toggle & language pill · right min/max/close.
 */
export default function TitleBar() {
  const t = useT();
  const win = getCurrentWindow();
  const { mode, setMode } = useThemeMode();
  const maximized = useMaximized();
  const [langOpen, setLangOpen] = useState(false);
  const { lang, setLang } = useI18n();

  return (
    <header className="relative h-9 shrink-0 bg-surface border-b border-line select-none z-50 flex items-center">
      {/* Drag region: brand area, left of the controls. Double-click toggles maximize. */}
      <div
        data-tauri-drag-region
        onDoubleClick={() => win.toggleMaximize().catch(() => {})}
        className="flex-1 min-w-0 pl-3 flex items-center"
      >
        <span className="text-sm font-semibold text-fg-bright truncate pointer-events-none"><img src="/logo.png" alt="" className="app-logo mr-1.5" />ChaChaanTeng</span>
      </div>

      {/* Right: light/dark toggle + language pill, snug against the window buttons */}
      <div className="relative flex items-center gap-2 pr-1">
        <button
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
          title={mode === "dark" ? t("titlebar.lightMode") : t("titlebar.darkMode")}
          className="btn btn-circle btn-xs btn-ghost border border-line bg-raised hover:bg-hover text-sm leading-none"
        >
          {mode === "dark" ? (
            <i className="fa-solid fa-sun" aria-hidden />
          ) : (
            <i className="fa-solid fa-moon" aria-hidden />
          )}
        </button>

        <div className="relative">
          <button
            onClick={() => setLangOpen((o) => !o)}
            title={t("titlebar.lang")}
            className="btn btn-ghost h-7 min-h-0 rounded-full border border-line bg-raised hover:bg-hover text-xs font-medium gap-1 pl-2.5 pr-2"
          >
            {/* endonym — each language's own name, independent of the active UI language */}
            {LANGS.find((l) => l.code === lang)?.label ?? ""}
            <i className="fa-solid fa-caret-down" aria-hidden />
          </button>
          {langOpen && (
            <>
              {/* invisible backdrop — click outside closes the menu */}
              <div className="fixed inset-0 z-40" onClick={() => setLangOpen(false)} />
              <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 min-w-[130px] z-50 bg-elevated border border-line rounded-md shadow-xl overflow-hidden">
                {LANGS.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => {
                      setLang(l.code);
                      setLangOpen(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-hover ${
                      lang === l.code ? "text-accent-text font-medium" : "text-fg"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right: Windows-style min / max / close */}
      <div className="flex items-stretch self-stretch">
        <button
          onClick={() => win.minimize().catch(() => {})}
          title={t("titlebar.minimize")}
          className="btn btn-ghost w-11 h-full rounded-none border-0 px-0 flex items-center justify-center text-fg-muted hover:bg-hover text-base leading-none"
        >
          <i className="fa-solid fa-minus" aria-hidden />
        </button>
        <button
          onClick={() => win.toggleMaximize().catch(() => {})}
          title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          className="btn btn-ghost w-11 h-full rounded-none border-0 px-0 flex items-center justify-center text-fg-muted hover:bg-hover text-sm leading-none"
        >
          {maximized ? (
            <i className="fa-solid fa-window-restore" aria-hidden />
          ) : (
            <i className="fa-solid fa-window-maximize" aria-hidden />
          )}
        </button>
        <button
          onClick={() => win.close().catch(() => {})}
          title={t("titlebar.close")}
          className="btn btn-ghost w-11 h-full rounded-none border-0 px-0 flex items-center justify-center text-fg-muted hover:bg-red hover:text-white text-sm leading-none"
        >
          <i className="fa-solid fa-xmark" aria-hidden />
        </button>
      </div>
    </header>
  );
}

/** Edge/corner hit zones — borderless windows lose native edge-resize on Windows. */
const ZONES: { dir: ResizeDir; cls: string }[] = [
  { dir: "North", cls: "top-0 left-3 right-3 h-1 cursor-n-resize" },
  { dir: "South", cls: "bottom-0 left-3 right-3 h-1 cursor-s-resize" },
  { dir: "West", cls: "left-0 top-3 bottom-3 w-1 cursor-w-resize" },
  { dir: "East", cls: "right-0 top-3 bottom-3 w-1 cursor-e-resize" },
  { dir: "NorthWest", cls: "top-0 left-0 h-3 w-3 cursor-nw-resize" },
  { dir: "NorthEast", cls: "top-0 right-0 h-3 w-3 cursor-ne-resize" },
  { dir: "SouthWest", cls: "bottom-0 left-0 h-3 w-3 cursor-sw-resize" },
  { dir: "SouthEast", cls: "bottom-0 right-0 h-3 w-3 cursor-se-resize" },
];

/** Eight transparent resize zones; hidden while maximized. Render inside a `relative` root. */
export function ResizeHandles() {
  const maximized = useMaximized();
  if (maximized) return null;
  return (
    <>
      {ZONES.map((z) => (
        <div
          key={z.dir}
          onPointerDown={(e) => {
            // must fire synchronously inside the pointer event for native resize to engage
            if (e.button === 0) getCurrentWindow().startResizeDragging(z.dir).catch(() => {});
          }}
          className={`absolute z-[60] ${z.cls}`}
        />
      ))}
    </>
  );
}
