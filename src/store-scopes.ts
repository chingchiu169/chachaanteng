import { create } from "zustand";
import { buildEffectiveFlagValues, cloneFlagValue, getDefaultValues } from "./flags/core";
import type { FlagValues } from "./flags/types";
import { getFlagValues, getModelOverrides, saveFlagValues, setModelOverride } from "./lib/api";

/** Sparse map of flag id → value; only non-default entries are stored. */
type SparseFlags = Record<string, unknown>;

// Serialize all persistence through one promise chain — the Rust commands are async
// read-modify-write (setModelOverride rewrites the whole model_overrides row), so two
// in-flight saves can complete out of order and let an older snapshot win on disk; the
// regression would only surface at next app start. One shared chain covers both rows.
// Every op RE-READS its row at write time (like saveSettingsMerged): after a terminally-failed
// load() the in-memory base is empty, and persisting over it would wipe every stored override.
let saveChain: Promise<unknown> = Promise.resolve();
function enqueueSave(op: () => Promise<unknown>): void {
  saveChain = saveChain.then(op).catch(() => {});
}

interface ScopesState {
  loaded: boolean;
  /** Global sparse flag overrides — the base layer every launch config starts from. */
  global: SparseFlags;
  /** Per-model sparse overrides keyed by absolute model path. */
  overrides: Record<string, SparseFlags>;

  load: () => Promise<void>;
  setGlobalValue: (id: string, value: unknown) => void;
  setOverride: (model: string, id: string, value: unknown) => void;
  /** Remove specific flag ids from the global layer — one save, not one per id. */
  resetGlobalFlags: (ids: string[]) => void;
  /** Remove specific flag ids from one model's override map — one save. */
  clearModelFlags: (model: string, ids: string[]) => void;
}

function makeScopesStore() {
  return create<ScopesState>((set, get) => ({
    loaded: false,
    global: {},
    overrides: {},

    load: async () => {
      // Bounded retries — a one-off IPC failure must not pin empty scopes for the session:
      // with loaded=true + empty global, the next setGlobalValue would save just that one
      // entry and wipe every stored override on disk.
      for (let attempt = 0; ; attempt++) {
        try {
          const [global, overrides] = await Promise.all([getFlagValues(), getModelOverrides()]);
          set({ global, overrides, loaded: true });
          return;
        } catch {
          if (attempt >= 2) {
            // app not ready yet — keep empty scopes; effective values fall back to defaults
            set({ loaded: true });
            return;
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    },

    setGlobalValue: (id, value) => {
      const mutate = (base: SparseFlags): SparseFlags => {
        const next = { ...base };
        if (value === undefined) delete next[id];
        else next[id] = cloneFlagValue(value);
        return next;
      };
      set({ global: mutate(get().global) });
      enqueueSave(async () => {
        const merged = mutate(await getFlagValues());
        set({ global: merged });
        await saveFlagValues(merged);
      });
    },

    // Setting a per-model value equal to the global one (or undefined) removes the
    // entry so the map stays sparse — the effective result is identical either way.
    setOverride: (model, id, value) => {
      const mutateModel = (base: SparseFlags): SparseFlags => {
        const next = { ...base };
        if (value === undefined || JSON.stringify(value) === JSON.stringify(get().global[id])) delete next[id];
        else next[id] = cloneFlagValue(value);
        return next;
      };
      const applyTo = (all: Record<string, SparseFlags>): Record<string, SparseFlags> => {
        const mergedModel = mutateModel(all[model] ?? {});
        const overrides = { ...all };
        if (Object.keys(mergedModel).length > 0) overrides[model] = mergedModel;
        else delete overrides[model];
        return overrides;
      };
      set({ overrides: applyTo(get().overrides) });
      enqueueSave(async () => {
        const all = await getModelOverrides();
        set({ overrides: applyTo(all) });
        await setModelOverride(model, mutateModel(all[model] ?? {}));
      });
    },

    resetGlobalFlags: (ids) => {
      const drop = new Set(ids);
      const mutate = (base: SparseFlags): SparseFlags => {
        const next: SparseFlags = {};
        for (const [k, v] of Object.entries(base)) if (!drop.has(k)) next[k] = v;
        return next;
      };
      set({ global: mutate(get().global) });
      enqueueSave(async () => {
        const merged = mutate(await getFlagValues());
        set({ global: merged });
        await saveFlagValues(merged);
      });
    },

    clearModelFlags: (model, ids) => {
      const drop = new Set(ids);
      const mutate = (base: SparseFlags): SparseFlags => {
        const next: SparseFlags = {};
        for (const [k, v] of Object.entries(base)) if (!drop.has(k)) next[k] = v;
        return next;
      };
      const applyTo = (all: Record<string, SparseFlags>): Record<string, SparseFlags> => {
        const mergedModel = mutate(all[model] ?? {});
        const overrides = { ...all };
        if (Object.keys(mergedModel).length > 0) overrides[model] = mergedModel;
        else delete overrides[model];
        return overrides;
      };
      set({ overrides: applyTo(get().overrides) });
      enqueueSave(async () => {
        const all = await getModelOverrides();
        set({ overrides: applyTo(all) });
        await setModelOverride(model, mutate(all[model] ?? {}));
      });
    },
  }));
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
const w = window as unknown as { __scopesStore?: ReturnType<typeof makeScopesStore> };
export const useScopes: ReturnType<typeof makeScopesStore> = (w.__scopesStore ??= makeScopesStore());

/** Effective values for a model = defaults + global overrides + per-model overrides. */
export function effectiveFor(
  global: SparseFlags,
  overrides: Record<string, SparseFlags>,
  model: string,
): FlagValues {
  return buildEffectiveFlagValues({ ...global, ...(overrides[model] ?? {}) });
}

/** The `port` flag's default, computed once from the definitions pipeline. */
const DEFAULT_PORT = Number(getDefaultValues().port);

/** Base port for QL tab allocation and external launch scripts — the `port` flag value in Global scope (what Configure shows), falling back to its default. */
export function basePort(): number {
  // Read the one flag directly instead of rebuilding all ~165 effective values per call.
  const v = Number(useScopes.getState().global.port ?? DEFAULT_PORT);
  return Number.isFinite(v) && v >= 1 ? Math.trunc(v) : DEFAULT_PORT;
}
