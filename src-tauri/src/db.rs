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
        Ok(Self { conn })
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
        .prepare("SELECT id, title, model_path, params FROM conversations ORDER BY id DESC")
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

#[tauri::command]
pub async fn delete_conversation(state: State<'_, crate::AppState>, id: i64) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    // One transaction — a failure between the two DELETEs must not orphan messages/conversation.
    let tx = db.conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM messages WHERE conv_id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM conversations WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
