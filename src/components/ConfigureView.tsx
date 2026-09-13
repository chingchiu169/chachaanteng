import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FLAGS, FLAG_CATEGORIES } from "../flags/definitions";
import { buildLaunchArgs, isFlagModified } from "../flags/core";
import type { FlagDef, FlagValues } from "../flags/types";
import { useFlags } from "../store-flags";
import { effectiveFor, useScopes } from "../store-scopes";
import { getModelsDirInfo, listLocalModels } from "../lib/api";
import { modelDisplayName } from "../lib/model-aliases";
import { useApp } from "../store";
import { useCatName, useFlagText, useT } from "../i18n";

import { ghostBtn, inputCls, secondaryBtn, selectCls, textareaCls } from "../lib/ui";

/** localStorage key for per-category collapse state (Phase G). */
const COLLAPSED_KEY = "chachaanteng-collapsed-sections";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** One flag row: label + type-specific control. Values come from the active scope. */
function FlagControl({
  f,
  values,
  setValue,
  overridden,
  modified,
}: {
  f: FlagDef;
  values: FlagValues;
  setValue: (id: string, value: unknown) => void;
  /** true when this flag has a per-model override in the active scope */
  overridden?: boolean;
  /** true when the effective value differs from the definition default */
  modified?: boolean;
}) {
  const t = useT();
  const flagText = useFlagText();
  const raw = values[f.id];
  const { label, short_desc } = flagText(f.id, f.label, f.short_desc);

  const pickPath = async () => {
    const path = await openFileDialog({ kind: "file", multiple: false });
    if (typeof path === "string" && path) setValue(f.id, path);
  };

  let control: React.ReactNode;
  switch (f.type) {
    case "bool": {
      const on = raw === true || (raw === undefined && f.default === true);
      control = (
        <button
          onClick={() => setValue(f.id, !on)}
          className={`btn btn-xs font-medium ${
            on
              ? "btn-soft btn-success"
              : "btn-ghost border border-line-strong bg-raised hover:bg-hover text-fg-muted"
          }`}
        >
          {on ? `ON ${f.flag}` : f.false_flag ? `OFF ${f.false_flag}` : "OFF"}
        </button>
      );
      break;
    }
    case "int":
    case "float": {
      const num = raw === undefined || raw === null ? (f.default as number) ?? "" : Number(raw);
      control = (
        <input
          type="number"
          value={Number.isFinite(num) ? String(num) : ""}
          min={f.min}
          max={f.max}
          step={f.step ?? (f.type === "int" ? 1 : 0.01)}
          placeholder={f.placeholder}
          onChange={(e) => {
            const v = e.target.value;
            setValue(f.id, v === "" ? undefined : Number(v));
          }}
          className={`${inputCls} w-28`}
        />
      );
      break;
    }
    case "enum": {
      control = (
        <select
          value={String(raw ?? f.default ?? "")}
          onChange={(e) => setValue(f.id, e.target.value)}
          className={`${selectCls} w-40`}
        >
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    }
    case "multi_enum": {
      const selected: string[] = Array.isArray(raw) ? raw.map(String) : [];
      control = (
        <div className="flex gap-1 flex-wrap max-w-[420px]">
          {(f.options ?? []).map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                onClick={() =>
                  setValue(
                    f.id,
                    on ? selected.filter((v) => v !== o.value) : [...selected, o.value],
                  )
                }
                className={`btn btn-xs ${
                  on ? "btn-soft btn-accent" : "btn-ghost border border-line-strong bg-raised hover:bg-hover text-fg-muted"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case "path":
      control = (
        <div className="flex gap-1 items-center">
          <input
            type="text"
            value={String(raw ?? "")}
            placeholder={f.placeholder}
            onChange={(e) => setValue(f.id, e.target.value)}
            className={`${inputCls} w-64`}
          />
          <button
            onClick={pickPath}
            className={ghostBtn}
          >
            {t("common.browse")}
          </button>
        </div>
      );
      break;
    case "text_list": {
      const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/);
      control = (
        <textarea
          rows={2}
          value={list.join("\n")}
          placeholder={f.placeholder}
          onChange={(e) => setValue(f.id, e.target.value)}
          className={`${textareaCls} w-64 resize-y`}
        />
      );
      break;
    }
    default: {
      // "text" (incl. gpu_layers auto/all/number)
      control = (
        <input
          type="text"
          value={String(raw ?? f.default ?? "")}
          placeholder={f.placeholder}
          onChange={(e) => setValue(f.id, e.target.value)}
          className={`${inputCls} w-40`}
        />
      );
    }
  }

  return (
    <div className="flex gap-3 items-center py-1.5">
      <div className="w-64 shrink-0">
        <div className="text-xs text-fg-bright" title={f.desc}>
          {modified && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-warning mr-1 align-middle"
              title={t("cfg.modifiedBadge")}
            />
          )}
          {label}{" "}
          <span className="font-mono text-[10px] text-fg-faint">{f.flag}</span>
          {overridden && (
            <span
              className="badge badge-xs badge-soft badge-accent ml-1.5 align-middle"
              title={t("cfg.overrideBadge")}
            >
              {t("cfg.overrideTag")}
            </span>
          )}
        </div>
        {short_desc && (
          <div className="text-[11px] text-fg-muted leading-snug mt-0.5">
            {short_desc}
          </div>
        )}
      </div>
      <div className="flex-1">{control}</div>
    </div>
  );
}

export default function ConfigureView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const catName = useCatName();
  const [query, setQuery] = useState("");
  const { settings } = useApp();
  const qlModel = useFlags((s) => s.model);
  const binaryTag = useFlags((s) => s.binaryTag);
  const { global, overrides, loaded, setGlobalValue, setOverride, resetGlobalFlags, clearModelFlags } =
    useScopes();

  // "" = Global base layer; otherwise an absolute .gguf path (per-model profile)
  const [scope, setScope] = useState("");
  const [localModels, setLocalModels] = useState<string[]>([]);

  // Re-listed each time the page is shown — new local models must appear in the scope dropdown
  // without a restart (previously the remount did this for free).
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      try {
        const info = await getModelsDirInfo();
        const list = await listLocalModels(info.models_dir);
        if (!alive) return;
        setLocalModels(
          list.map((f) => `${info.models_dir}/${f.rel_path}`.replace(/\//g, "\\")),
        );
      } catch {
        /* non-fatal — scope list just misses local files */
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible]);

  // Global + every known model (settings list ∪ local dir ∪ current QL pick)
  const scopeOptions = useMemo(() => {
    const set = new Set<string>([...localModels, ...(settings?.model_paths ?? [])]);
    if (qlModel) set.add(qlModel);
    return Array.from(set).sort();
  }, [localModels, settings, qlModel]);

  // effective values for the active scope: defaults + global (+ per-model overrides)
  const values = useMemo(
    () => (loaded ? effectiveFor(global, overrides, scope) : undefined),
    [loaded, global, overrides, scope],
  );

  // Flags whose effective value differs from the definition default (active scope).
  const modifiedIds = useMemo(() => {
    const m = new Set<string>();
    if (values) for (const f of FLAGS) if (isFlagModified(f, values)) m.add(f.id);
    return m;
  }, [values]);

  // Per-category {total, mod} counts — the header shows "mod/total" only when mod > 0.
  const catStats = useMemo(() => {
    const s: Record<string, { total: number; mod: number }> = {};
    for (const f of FLAGS) {
      const e = (s[f.category] ??= { total: 0, mod: 0 });
      e.total++;
      if (modifiedIds.has(f.id)) e.mod++;
    }
    return s;
  }, [modifiedIds]);

  // "Only modified" filter — session-only, not persisted.
  const [onlyModified, setOnlyModified] = useState(false);

  const setValue = (id: string, value: unknown) => {
    if (!values) return; // scopes not loaded yet — controls are disabled below
    if (scope === "") setGlobalValue(id, value);
    else setOverride(scope, id, value);
  };

  // Flag ids that have an entry in the ACTIVE scope's sparse map — what a section
  // reset can actually remove here (inherited global values aren't resettable per-model).
  const scopeEntryIds = useMemo(() => {
    const entries = scope === "" ? global : overrides[scope] ?? {};
    const m: Record<string, string[]> = {};
    for (const f of FLAGS) if (entries[f.id] !== undefined) (m[f.category] ??= []).push(f.id);
    return m;
  }, [scope, global, overrides]);

  const resetSection = (catId: string) => {
    const ids = scopeEntryIds[catId];
    if (!ids?.length) return;
    if (scope === "") resetGlobalFlags(ids);
    else clearModelFlags(scope, ids);
  };

  // custom args parse status (error blocks launch in Quick Launch)
  const argsResult = useMemo(
    () => buildLaunchArgs({ tool: "llama-server", model: "", flags: values ?? {}, binaryTag }),
    [values, binaryTag],
  );

  // expand/collapse per category, persisted; searching forces sections open
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const persistCollapsed = (next: Record<string, boolean>) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      /* non-fatal */
    }
  };
  const toggleSection = (id: string) => persistCollapsed({ ...collapsed, [id]: !collapsed[id] });
  const expandAll = () => persistCollapsed({});
  const collapseAll = () =>
    persistCollapsed(Object.fromEntries(FLAG_CATEGORIES.map((c) => [c.id, true])));

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    return FLAG_CATEGORIES.map((cat) => ({
      cat,
      flags: FLAGS.filter(
        (f) =>
          f.category === cat.id &&
          (!onlyModified || modifiedIds.has(f.id)) &&
          (!q ||
            f.label.toLowerCase().includes(q) ||
            f.id.includes(q) ||
            f.flag.includes(q)),
      ),
    })).filter((g) => g.flags.length > 0);
  }, [q, onlyModified, modifiedIds]);

  const totalShown = groups.reduce((n, g) => n + g.flags.length, 0);
  const scopeOverrides = scope === "" ? undefined : overrides[scope];

  return (
    <div className="h-full flex flex-col">
      {/* toolbar */}
      <div className="py-2 px-3 border-b border-line bg-surface flex gap-2 items-center flex-wrap">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          title={t("cfg.scope")}
          className={`${selectCls} max-w-[260px]`}
        >
          <option value="">{t("cfg.globalScope")}</option>
          {scopeOptions.map((p) => (
            <option key={p} value={p}>
              {/* alias if set, else basename minus .gguf — keeps long names readable inside the capped select */}
              {modelDisplayName(p, settings?.model_aliases)}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("cfg.searchPh", { n: FLAGS.length })}
          className={`${inputCls} flex-1 max-w-sm`}
        />
        <span className="text-[11px] text-fg-faint">{t("cfg.shownCount", { n: totalShown })}</span>
        {modifiedIds.size > 0 && (
          <span className="text-[11px] font-medium text-warning" title={t("cfg.modifiedBadge")}>
            ● {t("cfg.modifiedCount", { n: modifiedIds.size })}
          </span>
        )}
        <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
          <input
            type="checkbox"
            className="toggle toggle-xs border-line-strong toggle-warning"
            checked={onlyModified}
            onChange={(e) => setOnlyModified(e.target.checked)}
          />
          {t("cfg.onlyModified")}
        </label>
        <button onClick={expandAll} className={secondaryBtn}>
          {t("cfg.expandAll")}
        </button>
        <button onClick={collapseAll} className={secondaryBtn}>
          {t("cfg.collapseAll")}
        </button>
      </div>

      {/* grouped flags */}
      <div className="flex-1 overflow-y-auto space-y-0.5">
        {!loaded && (
          <div className="text-sm text-fg-faint py-4">{t("app.loading")}</div>
        )}
        {loaded &&
          groups.map(({ cat, flags }) => {
            const open = q ? true : !collapsed[cat.id];
            return (
              <div
                key={cat.id}
                className={`collapse rounded-none border-b border-line bg-surface ${open ? "collapse-open" : ""}`}
              >
                <div className="collapse-title w-full px-0 py-0 text-left flex items-center justify-between gap-2">
                  <button onClick={() => toggleSection(cat.id)} className="flex items-center min-w-0 flex-1 text-left min-h-[24px] px-3 py-2 hover:cursor-pointer">
                    <i className={`fa-solid fa-caret-right inline-block text-xs leading-none text-fg-faint transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
                    <span className="ml-1.5 text-sm font-semibold text-accent-text truncate">
                      {cat.icon && (
                        <i
                          className={`${cat.icon.startsWith("fa-brands") ? cat.icon : `fa-solid ${cat.icon}`} mr-1.5`}
                          aria-hidden
                        />
                      )}
                      {catName(cat.id, cat.name)}
                      <span className="ml-2 text-[11px] font-normal text-fg-faint">
                        {catStats[cat.id]?.mod ? `${catStats[cat.id].mod}/${catStats[cat.id].total}` : flags.length}
                      </span>
                    </span>
                  </button>
                  {(scopeEntryIds[cat.id] ?? []).length > 0 && (
                    <button
                      onClick={() => resetSection(cat.id)}
                      title={t("cfg.resetSectionTip")}
                      className={`${secondaryBtn} shrink-0`}
                    >
                      <i className="fa-solid fa-rotate-left mr-1" aria-hidden />
                      {t("cfg.resetSection")}
                    </button>
                  )}
                </div>
                {open && (
                  <div className="collapse-content divide-y divide-line px-4 pb-1">
                    {flags.map((f) => (
                      <FlagControl
                        key={f.id}
                        f={f}
                        values={values ?? {}}
                        setValue={setValue}
                        overridden={scopeOverrides?.[f.id] !== undefined}
                        modified={modifiedIds.has(f.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {loaded && totalShown === 0 && (
          <div className="text-sm text-fg-faint">{t("cfg.noMatch")}</div>
        )}

        {/* custom launch args — appended after UI-managed flags */}
        {loaded && (
          <section className="bg-surface p-3 space-y-2">
            <h2 className="text-sm font-semibold text-accent-text">
              <i className="fa-solid fa-puzzle-piece mr-1.5" aria-hidden />
              {t("cfg.customArgs")}
              <span className="ml-2 text-[11px] font-normal text-fg-faint">{t("cfg.advanced")}</span>
            </h2>
              <p className="text-[11px] text-fg-muted leading-snug">
                {t("cfg.customArgsHelp")}
              </p>
              <textarea
                rows={4}
                spellCheck={false}
                value={String(values?.custom_args ?? "")}
                placeholder={"--threads 8\n--flash-attn"}
                onChange={(e) =>
                  setValue("custom_args", e.target.value.trim() ? e.target.value : undefined)
                }
                className={`w-full textarea border-line-strong text-fg font-mono resize-y`}
              />
              <p className="text-[11px] text-yellow/80">{t("cfg.customArgsWarn")}</p>
              {argsResult.error && (
                <div role="alert" className="alert alert-error">
                  {argsResult.error}
                </div>
              )}
              {argsResult.warnings.map((w) => (
                <div key={w} role="alert" className="alert alert-warning">
                  {w}
                </div>
              ))}
          </section>
        )}
      </div>
    </div>
  );
}
