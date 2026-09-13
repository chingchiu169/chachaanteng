import { create } from "zustand";
import type { EngineInfo, Settings } from "./types";

interface AppState {
  settings: Settings | null;
  engines: EngineInfo[];
  setSettings: (s: Settings) => void;
  setEngines: (e: EngineInfo[]) => void;
}

function makeAppStore() {
  return create<AppState>((set) => ({
    settings: null,
    engines: [],
    setSettings: (settings) => set({ settings }),
    setEngines: (engines) => set({ engines }),
  }));
}

// HMR-safe singleton: Vite can serve several ?t= versions of this module in one page (each
// importer's cached transform embeds its own timestamp), and a plain create() would then yield
// several live store instances — UI bound to one, event routing to another. Sharing via window
// keeps every version pointing at the same instance.
const w = window as unknown as { __appStore?: ReturnType<typeof makeAppStore> };
export const useApp: ReturnType<typeof makeAppStore> = (w.__appStore ??= makeAppStore());
