import { useCallback } from "react";
import { create } from "zustand";
import { en, type EnKey } from "./en";
import { zhTw } from "./zh-tw";
import { CAT_ZH_TW, FLAG_ZH_TW } from "./flags-zh-tw";

export type Lang = "en" | "zh-TW";

const STORAGE_KEY = "chachaanteng-lang";
const LANGS: readonly string[] = ["en", "zh-TW"];

/** Default UI language is Traditional Chinese. */
function normalizeLang(l?: string | null): Lang {
  return l && (LANGS as string[]).includes(l) ? (l as Lang) : "zh-TW";
}

function getStoredLang(): Lang {
  try {
    return normalizeLang(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "zh-TW";
  }
}

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

function makeI18nStore() {
  return create<I18nState>((set) => ({
    lang: getStoredLang(),
    setLang: (lang) => {
      const next = normalizeLang(lang);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* non-fatal */
      }
      document.documentElement.lang = next;
      set({ lang: next });
    },
  }));
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
const w = window as unknown as { __i18nStore?: ReturnType<typeof makeI18nStore> };
export const useI18n: ReturnType<typeof makeI18nStore> = (w.__i18nStore ??= makeI18nStore());

type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Record<string, string>> = { en, "zh-TW": zhTw };

/** Non-reactive lookup (for use outside React renders). */
function translate(lang: Lang, key: EnKey, vars?: Vars): string {
  let s = DICTS[lang][key] ?? en[key] ?? String(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Reactive t() — the component re-renders when the language changes. */
export function useT(): (key: EnKey, vars?: Vars) => string {
  const lang = useI18n((s) => s.lang);
  return useCallback((key, vars?) => translate(lang, key, vars), [lang]);
}

/** Localized flag label / short description — falls back to the English definition text. */
export function useFlagText() {
  const lang = useI18n((s) => s.lang);
  return useCallback(
    (id: string, fallbackLabel: string, fallbackShort?: string | null) => ({
      label: lang === "zh-TW" ? FLAG_ZH_TW[id]?.label ?? fallbackLabel : fallbackLabel,
      short_desc:
        lang === "zh-TW"
          ? FLAG_ZH_TW[id]?.short_desc ?? fallbackShort ?? undefined
          : fallbackShort ?? undefined,
    }),
    [lang],
  );
}

/** Localized category name — falls back to the English category name. */
export function useCatName() {
  const lang = useI18n((s) => s.lang);
  return useCallback(
    (id: string, fallback: string) => (lang === "zh-TW" ? CAT_ZH_TW[id] ?? fallback : fallback),
    [lang],
  );
}
