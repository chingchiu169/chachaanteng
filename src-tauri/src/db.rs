use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: PathBuf) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT, model_path TEXT, params TEXT, created_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conv_id INTEGER, role TEXT, content TEXT, created_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);",
        )?;
        // First schema migration — conversations.deleted_at (soft delete / trash). This is the
        // app's migration pattern going forward: idempotent pragma_table_info check + ALTER TABLE,
        // run on every open. No PRAGMA user_version yet (single column).
        let has_deleted_at: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name = 'deleted_at'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e)?;
        if has_deleted_at == 0 {
            conn.execute("ALTER TABLE conversations ADD COLUMN deleted_at INTEGER", [])?;
        }
        Ok(Self { conn })
    }

    /// Permanently remove conversations trashed more than `days` ago (messages first, one transaction).
    pub fn purge_old_trash(&mut self, days: u64) -> Result<usize, rusqlite::Error> {
        let cutoff = now_ms() - days as i64 * 86_400_000;
        let tx = self.conn.transaction()?;
        // Subquery keeps this to two statements — no statement borrow held across the DELETEs.
        tx.execute(
            "DELETE FROM messages WHERE conv_id IN (SELECT id FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?1)",
            [cutoff],
        )?;
        let n = tx.execute(
            "DELETE FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            [cutoff],
        )?;
        tx.commit()?;
        Ok(n)
    }

    /// Read a setting row. `Ok(None)` = key absent; `Err` = real DB failure (corruption/lock).
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, rusqlite::Error> {
        match self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }
}

/// Full app settings blob, stored as one JSON row. Every field's natural default is the right
/// fallback for missing keys in old blobs (the per-field `#[serde(default)]`s keep that true).
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    /// Path to llama-server.exe (installed or custom). None = pick first installed.
    pub engine_exe: Option<String>,
    #[serde(default)]
    pub model_paths: Vec<String>,
    /// Optional SearXNG instance base URL (e.g. http://localhost:8081). Empty = DDG only.
    #[serde(default)]
    pub searxng_url: Option<String>,
    /// Absolute path of the models root for HF downloads / local listing. None = app-managed default.
    #[serde(default)]
    pub models_dir: Option<String>,
    /// Default model preselected in new Quick Launch tabs. None = empty pick.
    #[serde(default)]
    pub default_model: Option<String>,
    /// Display wall-clock times in 24-hour format (false = locale default, usually 12h).
    #[serde(default)]
    pub use_24h: bool,
    /// Server log retention in days; logs older than this are pruned at app start. 0 = keep everything.
    #[serde(default)]
    pub log_retention_days: u32,
    /// Per-model display aliases keyed by absolute model path (sparse — only models with an alias).
    #[serde(default)]
    pub model_aliases: HashMap<String, String>,
    /// HF repo info fetched after download, keyed by absolute model path (sparse). Values are the
    /// `hf_model_info` payloads kept as raw JSON so new API fields need no Rust change.
    #[serde(default)]
    pub model_meta: HashMap<String, serde_json::Value>,
}

#[tauri::command]
pub async fn get_settings(state: State<'_, crate::AppState>) -> Result<Settings, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let json = db.get_setting("settings").map_err(|e| e.to_string())?;
    Ok(json.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, crate::AppState>,
    settings: Settings,
) -> Result<(), String> {
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.set_setting("settings", &json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Flag value persistence — global base layer + sparse per-model overrides
// (plain KV rows, no schema migration)
// ---------------------------------------------------------------------------

/// Read a JSON setting row as an object — a missing or malformed row yields an empty object.
fn json_object_setting(
    db: &Db,
    key: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let json = db.get_setting(key).map_err(|e| e.to_string())?;
    Ok(json
        .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default())
}

/// The persisted GLOBAL flag set — the base layer every launch config starts from.
#[tauri::command]
pub async fn get_flag_values(state: State<'_, crate::AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    Ok(serde_json::Value::Object(json_object_setting(&db, "flag_values")?))
}

#[tauri::command]
pub async fn save_flag_values(state: State<'_, crate::AppState>, values: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(&values).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.set_setting("flag_values", &json).map_err(|e| e.to_string())
}

/// Sparse per-model overrides — one JSON row `{ [modelPath]: { flagId: value } }`.
#[tauri::command]
pub async fn get_model_overrides(state: State<'_, crate::AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    Ok(serde_json::Value::Object(json_object_setting(&db, "model_overrides")?))
}

/// Replace one model's override map. An empty object deletes the entry (keeps the row sparse).
#[tauri::command]
pub async fn set_model_override(
    state: State<'_, crate::AppState>,
    model_path: String,
    overrides: serde_json::Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut all = json_object_setting(&db, "model_overrides")?;
    if overrides.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        all.remove(&model_path);
    } else {
        all.insert(model_path, overrides);
    }
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    db.set_setting("model_overrides", &json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Conversation persistence (FR2.5)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub model_path: Option<String>,
    /// JSON blob of chat params (temperature/top_p/max_tokens/…) at save time.
    pub params: Option<serde_json::Value>,
}

/// One persisted chat message — only the fields the UI reads (role + content).
#[derive(Serialize, Deserialize, Clone)]
pub struct StoredMessage {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn list_conversations(state: State<'_, crate::AppState>) -> Result<Vec<Conversation>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut stmt = db
        .conn
        .prepare(
            "SELECT id, title, model_path, params FROM conversations WHERE deleted_at IS NULL ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                title: r.get(1)?,
                model_path: r.get(2)?,
                params: r
                    .get::<_, Option<String>>(3)?
                    .and_then(|p| serde_json::from_str(&p).ok()),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_messages(state: State<'_, crate::AppState>, conv_id: i64) -> Result<Vec<StoredMessage>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut stmt = db
        .conn
        .prepare("SELECT role, content FROM messages WHERE conv_id = ?1 ORDER BY id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([conv_id], |r| {
            Ok(StoredMessage {
                role: r.get(0)?,
                content: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Insert a new conversation (or update an existing one when id > 0). Returns the id.
#[tauri::command]
pub async fn save_conversation(
    state: State<'_, crate::AppState>,
    id: i64,
    title: String,
    model_path: Option<String>,
    params: Option<serde_json::Value>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let params_json = params.and_then(|p| serde_json::to_string(&p).ok());
    if id > 0 {
        db.conn
            .execute(
                "UPDATE conversations SET title = ?1, model_path = ?2, params = ?3 WHERE id = ?4",
                params![title, model_path, params_json, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        db.conn
            .execute(
                "INSERT INTO conversations (title, model_path, params, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![title, model_path, params_json, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn append_message(
    state: State<'_, crate::AppState>,
    conv_id: i64,
    role: String,
    content: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.conn
        .execute(
            "INSERT INTO messages (conv_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![conv_id, role, content, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, crate::AppState>,
    id: i64,
    title: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.conn
        .execute("UPDATE conversations SET title = ?1 WHERE id = ?2", params![title, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Soft delete — moves the conversation to trash. Messages stay on disk until restore or the
/// 30-day auto-purge at app start; `purge_conversation` is the hard path.
#[tauri::command]
pub async fn delete_conversation(state: State<'_, crate::AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.conn
        .execute(
            "UPDATE conversations SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// A trashed conversation row — only the fields the trash UI shows.
#[derive(Serialize, Clone)]
pub struct TrashedConversation {
    pub id: i64,
    pub title: String,
    /// ms epoch when it was moved to trash (auto-purged 30 days later at app start)
    pub deleted_at: i64,
}

#[tauri::command]
pub async fn restore_conversation(state: State<'_, crate::AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.conn
        .execute(
            "UPDATE conversations SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hard delete — the old irreversible path, now only reachable from the trash UI.
#[tauri::command]
pub async fn purge_conversation(state: State<'_, crate::AppState>, id: i64) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    // One transaction — a failure between the two DELETEs must not orphan messages/conversation.
    let tx = db.conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM messages WHERE conv_id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM conversations WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// One conversation matched by `search_conversations`.
#[derive(Serialize, Clone)]
pub struct ConvSearchHit {
    pub id: i64,
    /// Short window around the first matching message; None when only the title matched.
    pub snippet: Option<String>,
}

/// Case-insensitive search across conversation titles AND message contents (LIKE-based —
/// personal-scale data, no FTS5 dependency). One hit per matching conversation.
#[tauri::command]
pub async fn search_conversations(
    state: State<'_, crate::AppState>,
    query: String,
) -> Result<Vec<ConvSearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // Escape LIKE wildcards so user-typed % / _ match literally.
    let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut stmt = db
        .conn
        .prepare(
            "SELECT id FROM conversations
             WHERE deleted_at IS NULL
               AND (lower(title) LIKE ?1 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM messages m
                               WHERE m.conv_id = conversations.id AND lower(m.content) LIKE ?1 ESCAPE '\\'))
             ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = stmt
        .query_map([like.as_str()], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let snippet = db
            .conn
            .query_row(
                "SELECT content FROM messages WHERE conv_id = ?1 AND lower(content) LIKE ?2 ESCAPE '\\' ORDER BY id ASC LIMIT 1",
                params![id, like],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|c| snippet_window(&c, &q));
        out.push(ConvSearchHit { id, snippet });
    }
    Ok(out)
}

/// ~30 chars before + ~40 after the first case-insensitive match; newlines collapsed.
fn snippet_window(content: &str, needle: &str) -> Option<String> {
    let lower: Vec<char> = content.to_lowercase().chars().collect();
    let needle_chars: Vec<char> = needle.chars().collect();
    if needle_chars.is_empty() || lower.len() < needle_chars.len() {
        return None;
    }
    // Char-space match — byte offsets would miscount multi-byte (CJK) characters.
    let start = lower.windows(needle_chars.len()).position(|w| w == needle_chars.as_slice())?;
    let end = (start + needle_chars.len() + 40).min(lower.len());
    let s = start.saturating_sub(30);
    Some(lower[s..end].iter().collect::<String>().replace('\n', " ").replace('\r', ""))
}

#[tauri::command]
pub async fn list_trashed_conversations(
    state: State<'_, crate::AppState>,
) -> Result<Vec<TrashedConversation>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut stmt = db
        .conn
        .prepare(
            "SELECT id, title, deleted_at FROM conversations WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TrashedConversation {
                id: r.get(0)?,
                title: r.get(1)?,
                deleted_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
