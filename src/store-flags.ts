import { create } from "zustand";
import { buildEffectiveFlagValues, getDefaultValues } from "./flags/core";
import type { FlagValues } from "./flags/types";

interface FlagsState {
  /** absolute path of the selected .gguf */
  model: string;
  /** effective values (defaults merged in) — mirrors reference flagCore.flagValues semantics */
  values: FlagValues;
  /** engine version tag ("b10826" / "custom") — gates native --reasoning-effort etc. */
  binaryTag: string;

  setModel: (model: string) => void;
  /** wholesale replace with defaults + normalized data (preset load / import / model switch) */
  applyValues: (data: FlagValues | null) => void;
  setBinaryTag: (tag: string) => void;
}

function makeFlagsStore() {
  return create<FlagsState>((set) => ({
    model: "",
    values: getDefaultValues(),
    binaryTag: "",

    setModel: (model) => set({ model }),

    applyValues: (data) => {
      set({ values: buildEffectiveFlagValues(data ?? {}) });
    },

    setBinaryTag: (tag) => {
      set({ binaryTag: tag });
    },
  }));
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
const w = window as unknown as { __flagsStore?: ReturnType<typeof makeFlagsStore> };
export const useFlags: ReturnType<typeof makeFlagsStore> = (w.__flagsStore ??= makeFlagsStore());
