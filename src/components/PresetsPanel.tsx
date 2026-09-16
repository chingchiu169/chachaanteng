import { useCallback, useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import ConfirmDialog from "./ConfirmDialog";
import PromptDialog from "./PromptDialog";
import {
  archivePresets,
  deletePreset,
  listPresets,
  renamePreset,
  savePreset,
  writeTextFile,
  type PresetInfo,
} from "../lib/api";
import { buildLaunchArgs, flattenArgs } from "../flags/core";
import { basePort } from "../store-scopes";
import { useApp } from "../store";
import { useFlags } from "../store-flags";
import { useT } from "../i18n";
import { isMac } from "../lib/platform";
import { secondaryBtn, selectCls } from "../lib/ui";

/** What a preset captures — enough to reproduce a launch configuration. */
export interface PresetData {
  model: string;
  flags: Record<string, unknown>;
  engine_exe?: string | null;
  port?: number;
}

interface Props {
  /** Called when the user loads a preset — parent applies it to its own state. */
  onApply: (data: PresetData) => void;
  /** Current Quick Launch port, captured into presets saved from here. */
  currentPort?: number;
}

/** Quote a single argument for a Windows .cmd file. */
function quoteCmd(s: string): string {
  return /[ \t"&|%^!()<>]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export default function PresetsPanel({ onApply, currentPort }: Props) {
  const t = useT();
  const { settings, engines } = useApp();
  const { model, values, binaryTag } = useFlags();

  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState("");

  // naming modal (window.prompt is suppressed in the Tauri webview) + delete confirm
  const [naming, setNaming] = useState<null | { mode: "save" | "rename"; initial?: string }>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const refresh = useCallback(() => {
    listPresets()
      .then(setPresets)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const visible = presets.filter((p) => showArchived || !p.archived);
  // Search the VISIBLE list — archiving the selected preset must disable Load/Rename/Delete,
  // not leave them acting on a row that no longer appears in the dropdown.
  const selectedPreset = visible.find((p) => p.name === selected);

  const startSave = () => setNaming({ mode: "save" });

  const startRename = () => {
    if (!selectedPreset) return;
    setNaming({ mode: "rename", initial: selectedPreset.name });
  };

  /** Commit the naming modal (save a new preset, or rename the selection). */
  const submitNaming = async (name: string) => {
    const mode = naming?.mode;
    setNaming(null);
    if (!name || !mode) return;
    try {
      if (mode === "save") {
        const saved = await savePreset(
          name,
          { model, flags: values as Record<string, unknown>, engine_exe: settings?.engine_exe ?? null, port: currentPort ?? null },
          true,
        );
        refresh();
        setSelected(saved);
        setError("");
      } else if (selectedPreset && name !== selectedPreset.name) {
        await renamePreset(selectedPreset.name, name);
        refresh();
        setSelected(name);
        setError("");
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const loadSelected = () => {
    if (!selectedPreset) return;
    onApply(selectedPreset.data as unknown as PresetData);
    setError("");
  };

  const requestDelete = () => {
    if (selectedPreset) setConfirmDel(true);
  };

  const doDelete = async () => {
    const name = selectedPreset?.name;
    setConfirmDel(false);
    if (!name) return;
    try {
      await deletePreset(name);
      setSelected("");
      refresh();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleArchive = async () => {
    if (!selectedPreset) return;
    try {
      await archivePresets([selectedPreset.name], !selectedPreset.archived);
      refresh();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  /** FR3.3 — export a .cmd that launches llama-server with this preset's config. */
  const exportShortcut = async () => {
    if (!selectedPreset) return;
    const data = selectedPreset.data as unknown as PresetData;
    const engineExe = data.engine_exe || settings?.engine_exe || engines[0]?.path;
    if (!engineExe) {
      setError(t("presets.noEngine"));
      return;
    }
    const result = buildLaunchArgs({ tool: "llama-server", model: data.model, flags: data.flags as never, binaryTag });
    if (result.error) {
      setError(result.error);
      return;
    }
    const port = data.port ?? basePort();
    const tokens = flattenArgs(result.args);
    tokens.push("--host", "127.0.0.1", "--port", String(port));
    const script = [
      "@echo off",
      `title ChaChaanTeng - ${selectedPreset.name}`,
      `${quoteCmd(engineExe)} ${tokens.map(quoteCmd).join(" ")}`,
      "pause",
      "",
    ].join("\r\n");

    const dest = await saveDialog({
      defaultPath: `${selectedPreset.name}.cmd`,
      filters: [{ name: "Windows batch", extensions: ["cmd", "bat"] }],
    });
    if (!dest) return;
    try {
      await writeTextFile(dest, script);
      setError("");
    } catch (e) {
      setError(t("presets.exportFailed", { err: String(e) }));
    }
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-fg-muted shrink-0">{t("presets.label")}</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className={`${selectCls} min-w-[160px] max-w-[280px]`}
        >
          <option value="">{t("common.select")}</option>
          {visible.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.archived ? t("presets.archivedSuffix") : ""}
            </option>
          ))}
        </select>
        <button onClick={loadSelected} disabled={!selectedPreset} className={secondaryBtn}>
          {t("common.load")}
        </button>
        <button onClick={startSave} className={secondaryBtn}>
          {t("presets.saveCurrent")}
        </button>
        <button onClick={startRename} disabled={!selectedPreset} className={secondaryBtn}>
          {t("common.rename")}
        </button>
        <button onClick={toggleArchive} disabled={!selectedPreset} className={secondaryBtn}>
          {selectedPreset?.archived ? t("presets.restore") : t("presets.archive")}
        </button>
        <button onClick={requestDelete} disabled={!selectedPreset} className={secondaryBtn}>
          {t("common.delete")}
        </button>
        {!isMac() && (
          <button onClick={exportShortcut} disabled={!selectedPreset} title={t("presets.exportTitle")} className={secondaryBtn}>
            {t("presets.exportCmd")}
          </button>
        )}
        <label className="flex items-center gap-1.5 text-xs text-fg-muted ml-auto cursor-pointer">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span className="leading-5">{t("presets.showArchived")}</span>
        </label>
      </div>

      {error && (
        <div role="alert" className="alert alert-soft alert-error">
          {error}
        </div>
      )}

      <PromptDialog
        open={naming !== null}
        title={t(naming?.mode === "rename" ? "common.rename" : "presets.saveCurrent")}
        placeholder={t(naming?.mode === "rename" ? "presets.newNamePrompt" : "presets.namePrompt")}
        initial={naming?.initial ?? ""}
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        onSubmit={(name) => void submitNaming(name)}
        onCancel={() => setNaming(null)}
      />
      <ConfirmDialog
        open={confirmDel}
        title={t("common.delete")}
        message={t("presets.deleteConfirm", { name: selectedPreset?.name ?? "" })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDel(false)}
      />
    </div>
  );
}
