// --- saved external servers (localStorage address book) ----------------------
// API keys are NOT stored here — they live in the OS credential store, keyed by
// host+port (see src-tauri/src/external.rs). This module is pure localStorage:
// load/persist plus list helpers shared by ChatView (header chips) and the
// Settings "External Servers" tab.

/** A saved external server address (no key material — see above). */
export interface SavedExt {
  host: string;
  port: number;
  label: string;
}

const SAVED_EXT_KEY = "chachaanteng-saved-ext";

/** All saved entries, or [] when storage is empty/corrupt. */
export function loadSavedExt(): SavedExt[] {
  try {
    const raw = localStorage.getItem(SAVED_EXT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedExt[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full list. Non-fatal — a lost write only costs convenience. */
export function persistSavedExt(list: SavedExt[]): void {
  try {
    localStorage.setItem(SAVED_EXT_KEY, JSON.stringify(list));
  } catch {
    /* non-fatal */
  }
}

/** Add or update an entry (deduped by host+port), newest first. Pure — caller persists. */
export function upsertSavedExt(list: SavedExt[], entry: SavedExt): SavedExt[] {
  return [entry, ...list.filter((x) => !(x.host === entry.host && x.port === entry.port))];
}

/** Remove an entry by host+port. Pure — caller persists. */
export function removeSavedExt(list: SavedExt[], host: string, port: number): SavedExt[] {
  return list.filter((x) => !(x.host === host && x.port === port));
}
