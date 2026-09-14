import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import {
  deleteLocalModel,
  deleteModelFile,
  getModelsDirInfo,
  hfCancelDownload,
  hfGetDownloadStatus,
  hfListRepoFiles,
  hfSearchModels,
  hfStartDownload,
  listLocalModels,
  saveSettings,
  type HfDownloadState,
  type HfFile,
  type HfModelHit,
  type HfRepoFiles,
  type LocalModelFile,
  type ModelsDirInfo,
} from "../lib/api";
import { useApp } from "../store";
import { useFlags } from "../store-flags";
import { useQl } from "../store-ql";
import ConfirmDialog from "./ConfirmDialog";
import ModelAliasInput from "./ModelAliasInput";
import Progress from "./Progress";
import { useT } from "../i18n";

import { fetchAndSaveModelMeta } from "../lib/model-meta";
import { isMac } from "../lib/platform";
import { inputCls, secondaryBtn, selectCls } from "../lib/ui";

const btnCls = "btn btn-primary btn-xs disabled:opacity-40";
/** HF download panel — model + mmproj pickers share one width. */
const modelSelectCls = `${selectCls} min-w-[300px] max-w-[480px]`;

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return "?";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Known model families, most-specific first — matched against the file name for an "Arch" badge. */
const MODEL_FAMILIES = [
  "qwen3-next", "qwen3-vl", "qwen2.5", "qwen3", "llama-3.3", "llama-3.1", "llama-3", "llama",
  "mistral-small", "mixtral", "mistral", "gemma-3n", "gemma-3", "gemma-2", "gemma",
  "phi-4", "phi-3", "deepseek-r1", "deepseek", "nemotron", "glm-4.5", "glm-4", "glm",
  "smollm", "starcoder", "codegemma", "magistral",
];

/** Derive display metadata (family / params / quant) from a GGUF file name — we don't read GGUF headers. */
function parseModelMeta(name: string): { family?: string; params?: string; quant?: string } {
  const lower = name.toLowerCase();
  // quant tokens may contain underscores (Q4_K_M, IQ2_XXS) — the class must span them or "Q4_K_M" truncates to "Q4_K"
  const qm = /(?:^|[^a-z0-9])(q\d{1,2}_[a-z0-9_]+|iq\d{1,2}_[a-z0-9_]+|f16|bf16|f32)(?![a-z0-9])/.exec(lower);
  const pm = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(lower);
  let family: string | undefined;
  for (const f of MODEL_FAMILIES) {
    if (lower.includes(f)) {
      family = f;
      break;
    }
  }
  return { family, params: pm ? `${pm[1]}B` : undefined, quant: qm ? qm[1].toUpperCase() : undefined };
}

/** Vision projector files — hidden from the list while paired with a main model, cascade-deleted with it. */
const isMmproj = (rel: string) => /mmproj/i.test(rel);

/** HF downloads land in `{owner}_{repo}/{file}.gguf` — split that folder into publisher + repo name for display. */
function splitPublisher(relPath: string): { publisher: string; model: string } {
  const parts = relPath.split(/[\\/]/);
  if (parts.length !== 2) return { publisher: "—", model: relPath };
  const i = parts[0].indexOf("_");
  if (i <= 0 || i === parts[0].length - 1) return { publisher: "—", model: relPath };
  return { publisher: parts[0].slice(0, i), model: parts[0].slice(i + 1) };
}

/// File name minus .gguf and its trailing quant token, lowercased — "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf" → "qwen2.5-vl-7b-instruct".
function modelStem(rel: string): string {
  const name = (rel.split(/[\\/]/).pop() ?? rel).toLowerCase();
  return name.replace(/\.gguf$/, "").replace(/-(?:q\d{1,2}_[a-z0-9_]+|iq\d{1,2}_[a-z0-9_]+|f16|bf16|f32)$/, "");
}

/// Dots/dashes/underscores all collapse to "-" so "qwen2.5" and "qwen2_5" compare equal.
const normStem = (s: string) => s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** An mmproj file belongs to a main model when their stems match (equal, or one contains the other with ≥8 chars). */
function mmprojMatches(rel: string, modelRel: string): boolean {
  const core = normStem(
    modelStem(rel)
      .split(/[^a-z0-9]+/)
      .filter((tok) => tok !== "mmproj")
      .join("-"),
  );
  const stem = normStem(modelStem(modelRel));
  if (!core || !stem) return false;
  if (core === stem) return true;
  const [shorter, longer] = core.length <= stem.length ? [core, stem] : [stem, core];
  return shorter.length >= 8 && longer.includes(shorter);
}

function metaBadge(v?: string): ReactNode {
  if (!v) return <span className="text-fg-faint">—</span>;
  return (
    <span className="badge badge-xs badge-soft font-mono font-normal px-2">{v}</span>
  );
}

// ---------------------------------------------------------------------------
// column sorting — every column is sortable except the actions column
// ---------------------------------------------------------------------------

type LocalSortKey = "family" | "params" | "publisher" | "model" | "alias" | "quant" | "size";
type ImportedSortKey = "family" | "params" | "publisher" | "model" | "alias" | "quant";

interface SortState {
  key: string;
  dir: 1 | -1; // 1 = ascending, -1 = descending
}

/** Click cycle on the same column: ascending → descending → back to default (natural order). A new column starts ascending. */
const nextSort = (prev: SortState | null, key: string): SortState | null => {
  if (!prev || prev.key !== key) return { key, dir: 1 };
  if (prev.dir === 1) return { key, dir: -1 };
  return null; // descending → back to natural order
};

/** Compare two cell values — numbers numerically, strings case-insensitively with numeric awareness ("2B" < "10B"). */
function cmpCell(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Sort rows by one cell getter — missing values sink to the bottom in either direction. */
function sortRows<T>(rows: T[], get: (r: T) => string | number | null, dir: 1 | -1): T[] {
  return [...rows].sort((x, y) => {
    const a = get(x);
    const b = get(y);
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return cmpCell(a, b) * dir;
  });
}

/** Clickable column header with a sort-direction indicator — cycles asc → desc → default. */
function SortTh({ label, state, sortKey, onChange }: { label: string; state: SortState | null; sortKey: string; onChange: (s: SortState | null) => void }) {
  const icon = state?.key === sortKey ? (state.dir === 1 ? "fa-sort-up" : "fa-sort-down") : "fa-sort";
  return (
    <button type="button" onClick={() => onChange(nextSort(state, sortKey))} className="inline-flex items-center gap-1 font-medium hover:text-fg-bright">
      {label}
      <i className={`fa-solid ${icon} text-[9px] opacity-60`} aria-hidden />
    </button>
  );
}

export default function ModelsView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const { settings, setSettings } = useApp();
  const setModel = useFlags((s) => s.setModel);

  // models root + local listing
  const [dirInfo, setDirInfo] = useState<ModelsDirInfo | null>(null);
  const [localFiles, setLocalFiles] = useState<LocalModelFile[]>([]);
  const [listingError, setListingError] = useState("");

  // Column sorting per table (null = natural order) — every column except actions
  const [sortLocal, setSortLocal] = useState<SortState | null>(null);
  const [sortImported, setSortImported] = useState<SortState | null>(null);

  // HF panel
  const [repoId, setRepoId] = useState("");
  /** Hidden — the branch Rust actually resolved for `files` (repos may default to "master"). */
  const [revision, setRevision] = useState("");
  const [files, setFiles] = useState<HfRepoFiles | null>(null);
  const [modelFile, setModelFile] = useState("");
  const [mmprojFile, setMmprojFile] = useState("");
  const [finding, setFinding] = useState(false);
  const [hfError, setHfError] = useState("");

  // HF search (FR4.2) — debounced repo lookup; clicking a hit fills the ID + finds files
  const [hfQuery, setHfQuery] = useState("");
  const [hfGgufOnly, setHfGgufOnly] = useState(false);
  const [hits, setHits] = useState<HfModelHit[] | null>(null);

  useEffect(() => {
    const q = hfQuery.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    let stale = false;
    const id = setTimeout(async () => {
      try {
        const r = await hfSearchModels(q, hfGgufOnly);
        if (!stale) setHits(r.slice(0, 25));
      } catch (e) {
        if (!stale) setHfError(String(e));
      }
    }, 400);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [hfQuery, hfGgufOnly]);

  // download progress (event-driven)
  const [dl, setDl] = useState<HfDownloadState | null>(null);

  /** rel_path comes back with forward slashes — normalize to native separators (no-op on macOS). */
  const absPath = useCallback(
    (rel: string) => `${dirInfo?.models_dir ?? ""}/${rel}`.replace(/\//g, isMac() ? "/" : "\\"),
    [dirInfo],
  );

  const refreshLocal = useCallback(async () => {
    try {
      const info = await getModelsDirInfo();
      setDirInfo(info);
      const list = await listLocalModels(info.models_dir);
      setLocalFiles(list);
      setListingError("");
    } catch (e) {
      setListingError(String(e));
    }
  }, []);

  // Download progress is event-driven and app-lifetime-ish — it keeps updating while the page is
  // hidden (a download started here can run on for minutes).
  useEffect(() => {
    const un = listen<HfDownloadState>("hf-download-progress", (e) => setDl(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Local list + download status are re-fetched each time the page is shown — new .gguf files
  // dropped into the models dir must appear without a restart (previously the remount did this).
  useEffect(() => {
    if (!visible) return;
    refreshLocal();
    hfGetDownloadStatus().then(setDl).catch(() => {});
  }, [visible, refreshLocal]);

  // One-time backfill for models downloaded before model-meta existed: derive a candidate repo id
  // from the folder name ({owner}_{repo}) and fetch once — failures are silent and never retried.
  const metaTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!visible || !dirInfo) return;
    const s = useApp.getState().settings;
    for (const f of localFiles) {
      if (isMmproj(f.rel_path)) continue;
      const abs = absPath(f.rel_path);
      if ((s?.model_meta ?? {})[abs] || metaTriedRef.current.has(abs)) continue;
      const folder = f.rel_path.split(/[\\/]/)[0] ?? "";
      const i = folder.indexOf("_");
      if (i <= 0 || i === folder.length - 1) continue; // no owner/repo structure to guess from
      metaTriedRef.current.add(abs);
      void fetchAndSaveModelMeta(abs, `${folder.slice(0, i)}/${folder.slice(i + 1)}`);
    }
  }, [visible, dirInfo, localFiles, absPath]);

  /** Shared confirm dialog — window.confirm is suppressed in the Tauri webview. */
  const [confirm, setConfirm] = useState<null | { title?: string; message: string; confirmLabel?: string; danger?: boolean; action: () => Promise<void> }>(null);

  const doConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    if (c) await c.action();
  };

  const deleteModel = (f: LocalModelFile) => {
    if (!dirInfo) return;
    // cascade: paired vision projector files go with their main model
    const related = localFiles.filter((m) => isMmproj(m.rel_path) && mmprojMatches(m.rel_path, f.rel_path));
    setConfirm({
      title: t("common.delete"),
      message:
        related.length > 0
          ? t("models.deleteWithRelated", { path: f.rel_path, n: related.length })
          : t("models.deleteConfirm", { path: f.rel_path }),
      danger: true,
      action: async () => {
        const targets = [f, ...related];
        // A target already absent on disk (deleted in Explorer, or a partial cascade earlier) is the
        // desired end state — treat it as success so settings/QL still get cleaned up.
        const gone = new Set<string>();
        let failed: string | null = null;
        for (const target of targets) {
          try {
            await deleteLocalModel(dirInfo.models_dir, target.rel_path);
            gone.add(absPath(target.rel_path));
          } catch (e) {
            const msg = String(e);
            if (msg.toLowerCase().includes("not found")) gone.add(absPath(target.rel_path));
            else { failed = msg; break; }
          }
        }
        if (gone.size > 0) {
          // Drop the path from EVERY Quick Launch tab and from the global "selected model" in one synchronous
          // block — QL's adopt effect re-injects any non-empty global model into the active idle tab, so leaving
          // either source stale resurrects the deleted model a render later.
          for (const p of gone) {
            useQl.getState().clearModel(p);
            if (useFlags.getState().model === p) useFlags.getState().setModel("");
          }
        }
        if (settings && gone.size > 0) {
          // drop the path from the known-models list, the default-model slot and any display aliases
          const hadAlias = [...gone].some((p) => (settings.model_aliases ?? {})[p] !== undefined);
          if (settings.model_paths.some((p) => gone.has(p)) || gone.has(settings.default_model ?? "") || hadAlias) {
            const model_aliases = { ...(settings.model_aliases ?? {}) };
            for (const p of gone) delete model_aliases[p];
            const next = {
              ...settings,
              model_paths: settings.model_paths.filter((p) => !gone.has(p)),
              default_model: gone.has(settings.default_model ?? "") ? null : settings.default_model,
              model_aliases,
            };
            setSettings(next);
            saveSettings(next).catch(() => {});
          }
        }
        // always refresh — a partially-deleted cascade must not leave stale rows behind
        refreshLocal();
        if (failed) void message(t("models.deleteFailed", { err: failed }));
      },
    });
  };

  /** Set/clear this model as the default preselected in new Quick Launch tabs. */
  const toggleDefaultModel = async (abs: string) => {
    if (!settings) return;
    const next = { ...settings, default_model: settings.default_model === abs ? null : abs };
    setSettings(next);
    await saveSettings(next).catch(() => {});
  };

  // User-imported models (Quick Launch Browse / settings.model_paths) that live
  // OUTSIDE the models root — listed separately with two-tier delete.
  const importedModels = useMemo(() => {
    const paths = settings?.model_paths ?? [];
    if (!dirInfo) return paths;
    const root = dirInfo.models_dir.replace(/\\/g, "/").toLowerCase();
    return paths.filter((p) => !p.toLowerCase().replace(/\\/g, "/").startsWith(root + "/"));
  }, [settings, dirInfo]);

  /** Remove only the list entry — keep the file on disk. */
  const removeImportedConfigOnly = (p: string) => {
    if (!settings) return;
    setConfirm({
      title: t("common.delete"),
      message: t("models.removeListConfirm", { name: p.split(/[\\/]/).pop() ?? p }),
      danger: true,
      action: async () => {
        const next = { ...settings, model_paths: settings.model_paths.filter((x) => x !== p) };
        setSettings(next);
        await saveSettings(next).catch(() => {});
      },
    });
  };

  /** Delete the file from disk AND remove the list entry. */
  const removeImportedWithFile = (p: string) => {
    if (!settings) return;
    setConfirm({
      title: t("common.delete"),
      message: t("models.deleteFileConfirm", { name: p.split(/[\\/]/).pop() ?? p }),
      danger: true,
      action: async () => {
        try {
          await deleteModelFile(p);
        } catch (e) {
          // already gone on disk — still drop the stale list entry
          if (!String(e).toLowerCase().includes("not found")) {
            void message(t("models.deleteFailed", { err: String(e) }));
            return;
          }
        }
        // same synchronous-block rule as deleteModel — see there for why both sources must clear together
        useQl.getState().clearModel(p);
        if (useFlags.getState().model === p) useFlags.getState().setModel("");
        const model_aliases = { ...(settings.model_aliases ?? {}) };
        delete model_aliases[p];
        const next = {
          ...settings,
          model_paths: settings.model_paths.filter((x) => x !== p),
          default_model: settings.default_model === p ? null : settings.default_model,
          model_aliases,
        };
        setSettings(next);
        await saveSettings(next).catch(() => {});
      },
    });
  };

  /** Pick a search hit — fills the repo ID and immediately lists its files. */
  const pickHit = (h: HfModelHit) => {
    setRepoId(h.id);
    setHfQuery("");
    setHits(null);
    void findFiles(h.id);
  };

  const findFiles = async (repo?: string) => {
    const rid = (repo ?? repoId).trim();
    if (!rid) {
      setHfError(t("hf.enterRepoFirst"));
      return;
    }
    setFinding(true);
    setHfError("");
    try {
      // reuse the resolved branch only when it belongs to this same repo — otherwise let Rust resolve the default
      const useRev = files && files.repo_id === rid ? revision : "";
      const result = await hfListRepoFiles(rid, useRev);
      setFiles(result);
      setRevision(result.revision);
      setModelFile(result.models.length === 1 ? result.models[0].name : "");
      setMmprojFile("");
    } catch (e) {
      setHfError(String(e));
    } finally {
      setFinding(false);
    }
  };

  const startDownload = async (overwrite: boolean) => {
    if (!modelFile) {
      setHfError(t("hf.chooseFileFirst"));
      return;
    }
    try {
      await hfStartDownload(repoId.trim(), revision || "main", modelFile, mmprojFile || null, overwrite);
      setHfError("");
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("Already exists:")) {
        setConfirm({ title: t("hf.replaceExisting"), message: msg, confirmLabel: t("hf.replace"), action: () => startDownload(true) });
        return;
      }
      setHfError(msg);
    }
  };

  const cancelDownload = async () => {
    try {
      await hfCancelDownload();
    } catch (e) {
      setHfError(String(e));
    }
  };

  const adoptedRef = useRef<string | null>(null);

  // when a download finishes, adopt the model + refresh the local list (persisted).
  // The effect re-fires on any settings change while dl is "done" — skip if already adopted.
  useEffect(() => {
    if (!dl) return;
    if (dl.status !== "done") {
      adoptedRef.current = null; // a new download starts — allow re-adoption of the same path later
      return;
    }
    if (!dl.model_path || adoptedRef.current === dl.model_path) return;
    adoptedRef.current = dl.model_path;
    setModel(dl.model_path);
    if (settings && !settings.model_paths.includes(dl.model_path)) {
      const next = { ...settings, model_paths: [...settings.model_paths, dl.model_path] };
      setSettings(next);
      saveSettings(next).catch(() => {});
    }
    refreshLocal();
    // enrich the new row with authoritative repo info (publisher / arch) — best-effort
    if (dl.repo_id) void fetchAndSaveModelMeta(dl.model_path, dl.repo_id);
  }, [dl, settings, setModel, setSettings, refreshLocal]);

  // Paired vision files are hidden (they follow their main model); orphaned ones stay visible so they can be cleaned up manually.
  // Memoized — a fresh array each render would defeat the localRows memo below (its dep never stabilizes).
  const visibleFiles = useMemo(() => {
    const mains = localFiles.filter((f) => !isMmproj(f.rel_path));
    return localFiles.filter(
      (f) => !isMmproj(f.rel_path) || !mains.some((m) => mmprojMatches(f.rel_path, m.rel_path)),
    );
  }, [localFiles]);

  // Per-row display values — shared by the table cells and the column sorters.
  const localRows = useMemo(
    () =>
      visibleFiles.map((f) => {
        const abs = absPath(f.rel_path);
        const meta = parseModelMeta(f.rel_path.split(/[\\/]/).pop() ?? f.rel_path);
        const { publisher, model } = splitPublisher(f.rel_path);
        // saved HF repo info wins over the filename/folder heuristics when present
        const hf = settings?.model_meta?.[abs];
        return {
          f,
          abs,
          isDef: settings?.default_model === abs,
          family: (hf?.gguf_architecture || meta.family) ?? null,
          params: meta.params ?? null,
          publisher: hf?.author || publisher,
          model: (hf?.id.split("/").pop() ?? "") || model,
          alias: settings?.model_aliases?.[abs] || null,
          quant: meta.quant ?? null,
          size: f.size_bytes,
        };
      }),
    [visibleFiles, absPath, settings],
  );

  const sortedLocalRows = useMemo(() => {
    if (!sortLocal) return localRows;
    const get: Record<LocalSortKey, (r: (typeof localRows)[number]) => string | number | null> = {
      family: (r) => r.family,
      params: (r) => (r.params ? parseFloat(r.params) : null),
      publisher: (r) => r.publisher,
      model: (r) => r.model,
      alias: (r) => r.alias,
      quant: (r) => r.quant,
      size: (r) => r.size,
    };
    return sortRows(localRows, get[sortLocal.key as LocalSortKey], sortLocal.dir);
  }, [localRows, sortLocal]);

  const importedRows = useMemo(
    () =>
      importedModels.map((p) => {
        const meta = parseModelMeta(p.split(/[\\/]/).pop() ?? p);
        return {
          path: p,
          family: meta.family ?? null,
          params: meta.params ?? null,
          // imported paths live outside the models root — no owner/repo structure to derive a publisher from
          publisher: "—",
          model: p.split(/[\\/]/).pop() ?? p,
          alias: settings?.model_aliases?.[p] || null,
          quant: meta.quant ?? null,
        };
      }),
    [importedModels, settings],
  );

  const sortedImportedRows = useMemo(() => {
    if (!sortImported) return importedRows;
    const get: Record<ImportedSortKey, (r: (typeof importedRows)[number]) => string | number | null> = {
      family: (r) => r.family,
      params: (r) => (r.params ? parseFloat(r.params) : null),
      publisher: (r) => r.publisher,
      model: (r) => r.model,
      alias: (r) => r.alias,
      quant: (r) => r.quant,
    };
    return sortRows(importedRows, get[sortImported.key as ImportedSortKey], sortImported.dir);
  }, [importedRows, sortImported]);

  const active = dl && ["starting", "downloading", "cancelling"].includes(dl.status);
  const pct = dl && dl.total > 0 ? Math.min(100, Math.round((dl.downloaded / dl.total) * 100)) : null;

  return (
    <div className="h-full overflow-y-auto">
      {/* FR4.1 — local GGUF listing (the models root itself is configured in Settings) */}
      <section className="border-b border-line bg-surface p-3">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-xs font-medium text-fg-bright">{t("models.title")}</h2>
          <button onClick={refreshLocal} className={`${secondaryBtn} ml-auto`}>
            {t("common.refresh")}
          </button>
        </div>
        {listingError && (
          <div role="alert" className="alert alert-error mt-2">
            {listingError}
          </div>
        )}
        {!listingError && visibleFiles.length === 0 && importedModels.length === 0 && (
          <div className="mt-2 rounded-md border border-dashed border-line-strong px-4 py-10 text-center">
            <i className="fa-solid fa-box-open mb-3 block text-xl text-fg-faint" aria-hidden />
            <div className="text-xs text-fg-muted">{t("models.empty")}</div>
          </div>
        )}
        {visibleFiles.length > 0 && (
          <div className="mt-2 border border-line rounded-md max-h-[300px] overflow-y-auto">
            <table className="table table-sm table-fixed w-full">
              {/* fixed layout: the Model column (no width) takes all remaining space */}
              <colgroup>
                <col style={{ width: "5.5rem" }} />
                <col style={{ width: "4rem" }} />
                <col style={{ width: "8rem" }} />
                <col />
                <col style={{ width: "9rem" }} />
                <col style={{ width: "7rem" }} />
                <col style={{ width: "5.5rem" }} />
                <col style={{ width: "6.5rem" }} />
              </colgroup>
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="text-[11px] text-fg-muted font-medium">
                  <th><SortTh label={t("models.colFamily")} state={sortLocal} sortKey="family" onChange={setSortLocal} /></th>
                  <th><SortTh label={t("models.colParams")} state={sortLocal} sortKey="params" onChange={setSortLocal} /></th>
                  <th><SortTh label={t("models.colPublisher")} state={sortLocal} sortKey="publisher" onChange={setSortLocal} /></th>
                  <th><SortTh label={t("models.colPath")} state={sortLocal} sortKey="model" onChange={setSortLocal} /></th>
                  <th><SortTh label={t("models.colAlias")} state={sortLocal} sortKey="alias" onChange={setSortLocal} /></th>
                  <th><SortTh label={t("models.colQuant")} state={sortLocal} sortKey="quant" onChange={setSortLocal} /></th>
                  <th className="text-right"><SortTh label={t("models.colSize")} state={sortLocal} sortKey="size" onChange={setSortLocal} /></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedLocalRows.map((row) => {
                  const f = row.f;
                  return (
                    <tr key={f.rel_path} className="hover:bg-hover text-xs">
                      <td>{metaBadge(row.family || undefined)}</td>
                      <td className="whitespace-nowrap text-fg-muted">{row.params ?? "—"}</td>
                      <td className="whitespace-nowrap text-fg-muted">{row.publisher}</td>
                      <td>
                        <button
                          onClick={() => setModel(row.abs)}
                          title={`${f.rel_path}\n${t("models.useInQlTitle")}`}
                          className="block w-full text-left font-mono truncate text-fg hover:text-accent-text"
                        >
                          {row.model}
                        </button>
                      </td>
                      <td><ModelAliasInput path={row.abs} /></td>
                      <td>{metaBadge(row.quant || undefined)}</td>
                      <td className="text-right whitespace-nowrap text-fg-muted">{fmtBytes(f.size_bytes)}</td>
                      <td className="text-right whitespace-nowrap">
                        <span className="inline-flex items-center gap-0.5">
                          <button
                            onClick={() => setModel(row.abs)}
                            title={t("models.useInQlTitle")}
                            className="btn btn-xs btn-ghost px-1 min-h-0 text-fg-muted hover:text-accent-text"
                          >
                            <i className="fa-solid fa-rocket" aria-hidden />
                          </button>
                          <button
                            onClick={() => toggleDefaultModel(row.abs)}
                            title={row.isDef ? t("models.clearDefaultTitle") : t("models.setDefaultTitle")}
                            className="btn btn-xs btn-ghost px-1 min-h-0"
                          >
                            <span
                              className={`mask mask-star-2 w-4 h-4 ${row.isDef ? "bg-orange-400" : "bg-line-strong hover:bg-orange-400/70"}`}
                            />
                          </button>
                          <button
                            onClick={() => deleteModel(f)}
                            title={`${t("common.delete")} ${f.rel_path}`}
                            className="btn btn-xs btn-ghost px-1 min-h-0 text-fg-faint hover:text-red"
                          >
                            <i className="fa-solid fa-trash-can" aria-hidden />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* user-imported models outside the root — two-tier delete */}
        {importedModels.length > 0 && (
          <>
            <div className="mt-3 text-xs font-medium text-fg-bright">{t("models.imported")}</div>
            <div className="mt-1 border border-line rounded-md max-h-[260px] overflow-y-auto">
              <table className="table table-sm table-fixed w-full">
                <colgroup>
                  <col style={{ width: "5.5rem" }} />
                  <col style={{ width: "4rem" }} />
                  <col style={{ width: "8rem" }} />
                  <col />
                  <col style={{ width: "9rem" }} />
                  <col style={{ width: "7rem" }} />
                  <col style={{ width: "13rem" }} />
                </colgroup>
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="text-[11px] text-fg-muted font-medium">
                    <th><SortTh label={t("models.colFamily")} state={sortImported} sortKey="family" onChange={setSortImported} /></th>
                    <th><SortTh label={t("models.colParams")} state={sortImported} sortKey="params" onChange={setSortImported} /></th>
                    <th><SortTh label={t("models.colPublisher")} state={sortImported} sortKey="publisher" onChange={setSortImported} /></th>
                    <th><SortTh label={t("models.colPath")} state={sortImported} sortKey="model" onChange={setSortImported} /></th>
                    <th><SortTh label={t("models.colAlias")} state={sortImported} sortKey="alias" onChange={setSortImported} /></th>
                    <th><SortTh label={t("models.colQuant")} state={sortImported} sortKey="quant" onChange={setSortImported} /></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedImportedRows.map((row) => {
                    const p = row.path;
                    return (
                      <tr key={p} className="hover:bg-hover text-xs">
                        <td>{metaBadge(row.family || undefined)}</td>
                        <td className="whitespace-nowrap text-fg-muted">{row.params ?? "—"}</td>
                        {/* imported paths live outside the models root — no owner/repo structure to derive a publisher from */}
                        <td className="whitespace-nowrap text-fg-muted">—</td>
                        <td>
                          <button
                            onClick={() => setModel(p)}
                            title={`${p}\n${t("models.useInQlTitle")}`}
                            className="block w-full text-left font-mono truncate text-fg hover:text-accent-text"
                          >
                            {row.model}
                          </button>
                        </td>
                        <td><ModelAliasInput path={p} /></td>
                        <td>{metaBadge(row.quant || undefined)}</td>
                        <td className="text-right whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <button
                              onClick={() => removeImportedConfigOnly(p)}
                              title={t("models.removeListOnlyTitle")}
                              className="btn btn-xs btn-ghost border border-line bg-raised hover:bg-hover text-fg-muted"
                            >
                              <i className="fa-solid fa-xmark mr-1" aria-hidden />
                              {t("models.removeFromList")}
                            </button>
                            <button
                              onClick={() => removeImportedWithFile(p)}
                              title={t("models.deleteFileTitle")}
                              className="btn btn-xs btn-ghost border border-line bg-raised hover:bg-red-subtle text-fg-muted hover:text-red"
                            >
                              <i className="fa-solid fa-trash-can mr-1" aria-hidden />
                              {t("models.deleteFileBtn")}
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* FR4.2/4.3 — HF download */}
      <section className="border-b border-line bg-surface p-3">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-xs font-medium text-fg-bright">{t("hf.title")}</h2>
        </div>
        
        {/* FR4.2 — search the hub instead of typing a repo ID */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={hfQuery}
            onChange={(e) => setHfQuery(e.target.value)}
            placeholder={t("hf.searchPh")}
            className={`${inputCls} w-64`}
          />
          <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-xs border-line-strong"
              checked={hfGgufOnly}
              onChange={(e) => setHfGgufOnly(e.target.checked)}
            />
            {t("hf.ggufOnly")}
          </label>
        </div>
        {hits !== null && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line bg-base">
            {hits.length === 0 ? (
              <div className="px-3 py-2 text-xs text-fg-faint">{t("hf.noHits")}</div>
            ) : (
              hits.map((h) => (
                <button
                  key={h.id}
                  onClick={() => pickHit(h)}
                  title={`${h.id} — ${fmtCount(h.downloads)} downloads`}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-hover border-b border-line last:border-b-0"
                >
                  <span className="text-xs font-mono truncate">{h.id}</span>
                  <span className="ml-auto text-[11px] text-fg-faint shrink-0"><i className="fa-solid fa-download mr-1" aria-hidden />{fmtCount(h.downloads)}</span>
                </button>
              ))
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap mt-2">
          <input
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            placeholder="owner/model"
            className={`${inputCls} w-64`}
          />
          <button onClick={() => void findFiles()} disabled={finding || !!active} className={btnCls}>
            {finding ? t("hf.looking") : t("hf.findFiles")}
          </button>
        </div>

        {files && (
          <div className="mt-3 space-y-2">
            {files.models.length === 0 ? (
              <div role="status" className="text-xs text-fg-muted">{t("hf.noGguf")}</div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-fg-muted">{t("hf.modelLabel")}</span>
              <select value={modelFile} onChange={(e) => setModelFile(e.target.value)} className={modelSelectCls}>
                <option value="">{t("common.select")}</option>
                {files.models.map((f: HfFile) => (
                  <option key={f.name} value={f.name}>
                    {f.name} ({fmtBytes(f.size)}{f.shard_count ? `, ${t("hf.shards", { n: f.shard_count })}` : ""})
                  </option>
                ))}
              </select>
            </div>
            )}
            {files.mmproj.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-fg-muted">mmproj:</span>
                <select value={mmprojFile} onChange={(e) => setMmprojFile(e.target.value)} className={modelSelectCls}>
                  <option value="">{t("hf.mmprojNone")}</option>
                  {files.mmproj.map((f: HfFile) => (
                    <option key={f.name} value={f.name}>
                      {f.name} ({fmtBytes(f.size)})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {!active && (
              <button onClick={() => startDownload(false)} disabled={!modelFile} className={btnCls}>
                {t("common.download")}
              </button>
            )}
          </div>
        )}

        {hfError && (
          <div role="alert" className="alert alert-error mt-2">
            {hfError}
          </div>
        )}

        {/* progress — shown while active or on error; cleared once done/cancelled */}
        {dl && (active || dl.status === "error") && (
          <div className="mt-3">
            {pct == null && active ? (
              <Progress />
            ) : (
              // only reachable while active or on error — done/cancelled unmount this block
              <Progress value={pct ?? 0} className={`progress ${dl.status === "error" ? "progress-error" : "progress-primary"}`} />
            )}
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className={dl.status === "error" ? "text-red" : "text-fg-muted"}>
                {pct != null && active
                  ? `${dl.current_file} ${pct}% (${fmtBytes(dl.downloaded)} / ${fmtBytes(dl.total)})`
                  : dl.message || dl.status}
              </span>
              {active && (
                <button onClick={cancelDownload} className="btn btn-xs btn-ghost border border-line bg-raised hover:bg-red-subtle text-fg hover:text-red">
                  {t("common.cancel")}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.confirmLabel ?? t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger={confirm?.danger ?? false}
        onConfirm={() => void doConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
