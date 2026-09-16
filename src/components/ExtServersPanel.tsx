import { useEffect, useState } from "react";
import { externalHasKey, externalStoreKey } from "../lib/api";
import {
  loadSavedExt,
  persistSavedExt,
  removeSavedExt,
  upsertSavedExt,
  type SavedExt,
} from "../lib/saved-ext";
import ConfirmDialog from "./ConfirmDialog";
import { useT } from "../i18n";
import { inputCls, labelCls, secondaryBtn } from "../lib/ui";
import { isMac } from "../lib/platform";

const MAX_LABEL = 120; // mirrors MAX_LABEL_LENGTH in src-tauri/src/external.rs
const MAX_KEY = 1024; // mirrors MAX_API_KEY_LENGTH there

/** Create/edit form state. `key === ""` means "no change" when editing an existing entry. */
interface Draft {
  host: string;
  port: number;
  label: string;
  key: string;
}

const addrKey = (host: string, port: number) => `${host}:${port}`;

/** Settings tab — CRUD for the saved external server address book. Purely local: no probes,
 *  no connections. API keys go to / come from the OS credential store via Rust commands. */
export default function ExtServersPanel({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const [list, setList] = useState<SavedExt[]>(loadSavedExt);
  /** host:port → whether an API key is stored in the OS credential store. */
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  /** addrKey of the entry being edited (null = creating a new one). */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [delTarget, setDelTarget] = useState<SavedExt | null>(null);

  // Re-read the address book each time the page is shown — ChatView's connect form can save
  // entries while this panel is hidden, and localStorage is the shared source of truth.
  useEffect(() => {
    if (visible) setList(loadSavedExt());
  }, [visible]);

  // Key badges — one credential-store read per saved entry (cheap; re-run when shown or when
  // the list changes).
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void (async () => {
      const next: Record<string, boolean> = {};
      for (const e of list) {
        try {
          next[addrKey(e.host, e.port)] = await externalHasKey(e.host, e.port);
        } catch {
          next[addrKey(e.host, e.port)] = false;
        }
      }
      if (alive) setKeys(next);
    })();
    return () => {
      alive = false;
    };
  }, [visible, list]);

  const startCreate = () => {
    setEditing(null);
    setDraft({ host: "", port: 8080, label: "", key: "" });
    setErr("");
  };

  const startEdit = (e: SavedExt) => {
    setEditing(addrKey(e.host, e.port));
    setDraft({ host: e.host, port: e.port, label: e.label, key: "" });
    setErr("");
  };

  /** Validate + persist the draft; a freshly entered key goes to the credential store. */
  const saveDraft = async () => {
    if (!draft) return;
    const host = draft.host.trim();
    const port = Number(draft.port);
    if (!host) {
      setErr(t("settings.extErrHost"));
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setErr(t("settings.extErrPort"));
      return;
    }
    const key = draft.key.trim();
    if (key.length > MAX_KEY) {
      setErr(t("settings.extErrKeyLen"));
      return;
    }

    setBusy(true);
    setErr("");
    try {
      // Blank keeps whatever is already stored — only an entered value replaces it.
      if (key !== "") await externalStoreKey(host, port, key);
      const entry = {
        host,
        port,
        label: draft.label.trim().slice(0, MAX_LABEL),
      };
      const nextList = upsertSavedExt(list, entry);
      setList(nextList);
      persistSavedExt(nextList);
      if (key !== "")
        setKeys((prev) => ({ ...prev, [addrKey(host, port)]: true }));
      setDraft(null);
      setEditing(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Drop the stored credential for the entry being edited — keyed off the ORIGINAL address,
   *  not the (possibly retyped) form values. */
  const clearKey = async () => {
    if (!draft || editing === null) return;
    const i = editing.lastIndexOf(":");
    const host = editing.slice(0, i);
    const port = Number(editing.slice(i + 1));
    setBusy(true);
    setErr("");
    try {
      await externalStoreKey(host, port, "");
      setKeys((prev) => ({ ...prev, [editing]: false }));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Remove the entry from the list and clear its stored credential. */
  const doDelete = async () => {
    const target = delTarget;
    setDelTarget(null);
    if (!target) return;
    try {
      await externalStoreKey(target.host, target.port, "");
    } catch {
      /* list removal still proceeds — a stale credential is harmless */
    }
    const nextList = removeSavedExt(list, target.host, target.port);
    setList(nextList);
    persistSavedExt(nextList);
  };

  return (
    <section className="bg-surface p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-medium text-fg-bright">
            {t("settings.extTitle")}
          </div>
          <p className="text-[11px] text-fg-muted mt-0.5">
            {t(isMac() ? "settings.extHelpMac" : "settings.extHelp")}
          </p>
        </div>
        {draft === null && (
          <button onClick={startCreate} className={secondaryBtn}>
            <i className="fa-solid fa-plus mr-1" aria-hidden />
            {t("settings.extAdd")}
          </button>
        )}
      </div>

      {list.length === 0 && draft === null ? (
        <div className="text-xs text-fg-faint">{t("settings.extEmpty")}</div>
      ) : list.length > 0 ? (
        <table className="table table-sm w-full text-xs">
          <thead>
            <tr>
              <th>{t("settings.extColLabel")}</th>
              <th>{t("settings.extColAddr")}</th>
              <th>{t("settings.extColKey")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((e) => {
              const k = addrKey(e.host, e.port);
              return (
                <tr key={k}>
                  <td>{e.label || "—"}</td>
                  <td className="font-mono">
                    {e.host}:{e.port}
                  </td>
                  <td>
                    {keys[k] ? (
                      <span className="badge badge-xs badge-soft badge-success">
                        <i className="fa-solid fa-key mr-1" aria-hidden />
                        {t("settings.extHasKey")}
                      </span>
                    ) : (
                      <span className="badge badge-xs badge-ghost">
                        {t("settings.extNoKey")}
                      </span>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button
                      onClick={() => startEdit(e)}
                      className={secondaryBtn}
                    >
                      {t("settings.extEdit")}
                    </button>{" "}
                    <button
                      onClick={() => setDelTarget(e)}
                      title={t("common.delete")}
                      className="btn btn-xs btn-ghost px-1 min-h-0 text-fg-faint hover:text-red"
                    >
                      <i className="fa-solid fa-trash-can" aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {draft !== null && (
        <div className="border border-line rounded-md p-2 space-y-1.5 bg-base">
          {/* all fields on one row — label + key share the leftover space, wraps only when narrow */}
          <div className="flex gap-3 flex-wrap items-center">
            <label className={labelCls}>
              <span className="min-w-[fit-content]">
                {t("settings.extLabel")}
              </span>
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder={t("settings.extLabelPh")}
                className={`${inputCls} w-full`}
              />
            </label>
            <label className={labelCls}>
              {t("settings.extHost")}
              <input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                placeholder="127.0.0.1"
                className={`${inputCls} w-36`}
              />
            </label>
            <label className={labelCls}>
              {t("settings.extPort")}
              <input
                type="number"
                value={draft.port}
                onChange={(e) =>
                  setDraft({ ...draft, port: Number(e.target.value) })
                }
                className={`${inputCls} w-20`}
              />
            </label>
            <label className={`${labelCls} flex-1 min-w-[180px]`}>
              <span className="min-w-[fit-content]">
                {t("settings.extKey")}
              </span>
              <input
                type="password"
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                placeholder={editing !== null ? t("settings.extKeyKeepPh") : ""}
                className={`${inputCls} w-full`}
              />
            </label>
            {editing !== null && keys[editing] === true && (
              <button
                onClick={() => void clearKey()}
                disabled={busy}
                className={secondaryBtn}
              >
                <i className="fa-solid fa-eraser mr-1" aria-hidden />
                {t("settings.extClearKey")}
              </button>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => void saveDraft()}
                disabled={busy || !draft.host.trim()}
                className="btn btn-primary btn-xs"
              >
                {t("common.save")}
              </button>
              <button
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                  setErr("");
                }}
                className={secondaryBtn}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {err && (
        <div role="alert" className="alert alert-soft alert-error">
          {err}
        </div>
      )}

      <ConfirmDialog
        open={delTarget !== null}
        title={t("settings.extDeleteTitle")}
        message={
          delTarget
            ? t("settings.extDeleteConfirm", {
                name: delTarget.label || `${delTarget.host}:${delTarget.port}`,
              })
            : ""
        }
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDelTarget(null)}
      />
    </section>
  );
}
