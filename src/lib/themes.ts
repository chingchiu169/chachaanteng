import { create } from "zustand";

/**
 * Theme modes — the app ships exactly two: "dark" and "light".
 * A mode is nothing but its palette block in styles.css, selected via
 * data-theme on <html>. (Was a 5-theme registry; simplified per user decision.)
 */

export type Mode = "dark" | "light";

const STORAGE_KEY = "chachaanteng-mode";
const MODES: readonly string[] = ["dark", "light"];

/** daisyUI theme names — the app defines custom llama-* themes in styles.css. */
const THEME_NAMES: Record<Mode, string> = { dark: "llama-dark", light: "llama-light" };

function normalizeMode(mode?: string | null): Mode {
  return mode && MODES.includes(mode) ? (mode as Mode) : "dark";
}

export function getStoredMode(): Mode {
  try {
    return normalizeMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "dark";
  }
}

/** Apply a mode by setting data-theme on <html>; persists unless persist=false. */
export function applyMode(mode: Mode, persist = true): Mode {
  const next = normalizeMode(mode);
  document.documentElement.dataset.theme = THEME_NAMES[next];
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }
  return next;
}

/** Reactive shared mode — TitleBar and Settings both read/write it (a local useState in each went stale). */
interface ThemeModeState {
  mode: Mode;
  setMode: (m: Mode) => void;
}

function makeThemeModeStore() {
  return create<ThemeModeState>((set) => ({
    mode: getStoredMode(),
    setMode: (mode) => set({ mode: applyMode(mode) }),
  }));
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
const w = window as unknown as { __themeModeStore?: ReturnType<typeof makeThemeModeStore> };
export const useThemeMode: ReturnType<typeof makeThemeModeStore> = (w.__themeModeStore ??= makeThemeModeStore());
