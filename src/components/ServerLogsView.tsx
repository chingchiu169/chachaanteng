import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { deleteServerLog, listServerLogs, readServerLog, type ServerLogFile } from "../lib/api";
import { useApp } from "../store";
import { fmtDateTime } from "../lib/time";
import ConfirmDialog from "./ConfirmDialog";
import { useT } from "../i18n";
import { inputCls, secondaryBtn } from "../lib/ui";

/** Parse server-{port}-{YYYYMMDD-HHMMSS}.log into [year, month, day] (null when the name doesn't match). */
function parseLogDate(name: string): [string, string, string] | null {
  const m = /^server-\d+-(\d{4})(\d{2})(\d{2})-\d{6}\.log$/.exec(name);
  return m ? [m[1], m[2], m[3]] : null;
}

const LS_SELECTED = "chachaanteng-log-selected";
const LS_PATH = "chachaanteng-log-path";

/** Persisted server logs — one file per Quick Launch session, browsed like a filesystem (year → month → day). */
export default function ServerLogsView({ visible = false }: { visible?: boolean }) {
  const t = useT();
  const { settings } = useApp();
  const [files, setFiles] = useState<ServerLogFile[]>([]);
  // Open log + tree position live in localStorage — with views staying mounted, it only buys
  // cross-restart persistence now (React state already survives tab switches).
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(LS_SELECTED) ?? "";
    } catch {
      /* non-fatal */
      return "";
    }
  });
  /** drill-down path, e.g. ["2026", "09"] — empty is the root (years) */
  const [path, setPath] = useState<string[]>(() => {
    try {
      const p: unknown = JSON.parse(localStorage.getItem(LS_PATH) ?? "[]");
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const [content, setContent] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(LS_SELECTED, selected);
    } catch {
      /* non-fatal */
    }
  }, [selected]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_PATH, JSON.stringify(path));
    } catch {
      /* non-fatal */
    }
  }, [path]);

  const refresh = useCallback(() => {
    listServerLogs()
      .then(setFiles)
      .catch(() => {});
  }, []);

  // Re-listed each time the page is shown — new log files must appear without a restart now that
  // the view stays mounted across tab switches (previously the remount did this for free).
  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  // Re-open the previously selected log once the file list arrives; silently drop it if the file is gone.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || files.length === 0) return;
    restoredRef.current = true;
    // trim drill-down segments whose folder no longer has any logs
    let p = path;
    while (p.length > 0 && !files.some((f) => { const d = parseLogDate(f.name); return d ? p.every((seg, i) => d[i] === seg) : false; })) {
      p = p.slice(0, -1);
    }
    if (p !== path) setPath(p);
    if (!selected || content !== null) return;
    if (!files.some((f) => f.name === selected)) {
      setSelected("");
      return;
    }
    readServerLog(selected).then(setContent).catch(() => {});
  }, [files, path, selected, content]);

  const open = async (name: string) => {
    if (!name) return;
    setSelected(name);
    try {
      setContent(await readServerLog(name));
    } catch (e) {
      void message(t("ql.cantReadLog", { err: String(e) }));
    }
  };

  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const requestRemove = (name: string) => setConfirmDel(name);

  const doRemove = async () => {
    const name = confirmDel;
    setConfirmDel(null);
    if (!name) return;
    try {
      await deleteServerLog(name);
      setFiles((fs) => fs.filter((x) => x.name !== name));
      if (selected === name) {
        setSelected("");
        setContent(null);
      }
    } catch (e) {
      void message(String(e));
    }
  };

  // search mode: flat list of every file whose name matches (case-insensitive)
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching ? files.filter((f) => f.name.toLowerCase().includes(query.trim().toLowerCase())) : []),
    [files, query, searching],
  );

  // tree mode: folder names available at the current level (newest first)
  const foldersAtLevel = useMemo(() => {
    if (searching || path.length >= 3) return [];
    const set = new Set<string>();
    for (const f of files) {
      const d = parseLogDate(f.name);
      if (!d) continue;
      let ok = true;
      for (let i = 0; i < path.length; i++) {
        if (d[i] !== path[i]) {
          ok = false;
          break;
        }
      }
      if (ok) set.add(d[path.length]);
    }
    return [...set].sort().reverse();
  }, [files, path, searching]);

  // files visible at the current level: day-level matches, or non-standard names at root
  const filesAtLevel = useMemo(() => {
    if (searching) return [];
    const out: ServerLogFile[] = [];
    for (const f of files) {
      const d = parseLogDate(f.name);
      if (!d && path.length === 0) out.push(f);
      else if (path.length === 3 && d?.every((p, i) => p === path[i])) out.push(f);
    }
    return out; // Rust already returns them newest first
  }, [files, path, searching]);

  const use24h = !!settings?.use_24h;

  const fileRow = (f: ServerLogFile) => (
    <div key={f.name} className={`group flex items-center border-b border-line hover:bg-hover ${selected === f.name ? "bg-accent-subtle" : ""}`}>
      <button onClick={() => open(f.name)} className="flex-1 min-w-0 text-left px-3 py-2">
        <div className="text-xs font-mono truncate">{f.name}</div>
        <div className="text-[10px] text-fg-faint">
          {(f.size_bytes / 1024).toFixed(0)} KB · {fmtDateTime(f.modified_ms, use24h)}
        </div>
      </button>
      <button
        onClick={() => requestRemove(f.name)}
        title={t("logs.deleteTitle")}
        className="opacity-0 group-hover:opacity-100 text-fg-muted hover:text-red px-2 shrink-0"
      >
        <i className="fa-solid fa-trash-can" aria-hidden />
      </button>
    </div>
  );

  return (
    <div className="h-full flex overflow-hidden">
      {/* file tree */}
      <aside className="w-80 shrink-0 border-r border-line bg-surface flex flex-col">
        <div className="shrink-0 px-3 py-2 border-b border-line space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-bright">{t("logs.title")}</span>
            <button onClick={refresh} className={secondaryBtn}>
              {t("common.refresh")}
            </button>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("logs.searchPh")}
            className={`${inputCls} w-full`}
          />
        </div>

        {/* breadcrumbs — click a segment to go back up; the leading "/" is always rendered so
            drilling into the first year doesn't shift the layout (nothing → something) */}
        {!searching && (
          <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-line text-[11px] overflow-x-auto whitespace-nowrap">
            <span className="text-fg-faint">/</span>
            {path.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-fg-faint">/</span>}
                <button onClick={() => setPath(path.slice(0, i))} className="hover:text-accent-text text-fg-muted">
                  <i className="fa-solid fa-folder mr-1" aria-hidden />{seg}
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {searching ? (
            results.length === 0 ? (
              <div className="p-3 text-xs text-fg-faint">{t("logs.noMatches")}</div>
            ) : (
              results.map(fileRow)
            )
          ) : files.length === 0 && path.length === 0 ? (
            <div className="p-3 text-xs text-fg-faint">{t("logs.empty")}</div>
          ) : (
            <>
              {foldersAtLevel.map((name) => (
                <button
                  key={name}
                  onClick={() => setPath([...path, name])}
                  className="w-full text-left px-3 py-2 border-b border-line hover:bg-hover"
                >
                  <i className="fa-solid fa-folder mr-1" aria-hidden />{name}
                </button>
              ))}
              {filesAtLevel.map(fileRow)}
            </>
          )}
        </div>
      </aside>

      {/* content */}
      <main className="flex-1 min-w-0 flex flex-col bg-base">
        {content === null ? (
          <div className="flex-1 flex items-center justify-center text-xs text-fg-faint">{t("logs.selectHint")}</div>
        ) : (
          <>
            <div className="shrink-0 px-3 py-2 border-b border-line bg-surface">
              <span className="text-[11px] font-mono text-fg-muted truncate block" title={selected}>
                {selected}
              </span>
            </div>
            <pre className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-[11px] leading-relaxed text-fg-muted font-mono whitespace-pre-wrap break-all">
              {content}
            </pre>
          </>
        )}
      </main>

      <ConfirmDialog
        open={confirmDel !== null}
        title={t("logs.deleteTitle")}
        message={t("logs.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doRemove()}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}
