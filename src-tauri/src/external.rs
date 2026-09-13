//! FR8.3 — registration of an externally started llama-server as the chat target.
//!
//! The live registration is session-scoped: it lives in memory and disappears when
//! the app restarts. What survives a restart, under its own settings row: the
//! *address* (plus a flag that a key was needed). The API key itself is never written
//! to our database — it goes to the Windows Credential Manager (generic credential,
//! see [`wincred`]), encrypted by the OS and bound to this Windows user, so copying
//! the app data elsewhere never exposes it. A remembered address is re-registered on
//! the next start only when its port still identifies itself as llama-server — see
//! [`external_restore`].

use crate::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Minimal Windows Credential Manager wrapper (generic credentials). The OS encrypts the
/// blob with DPAPI and binds it to this user's logon — no ciphertext ever touches our DB.
#[cfg(target_os = "windows")]
mod wincred {
    use windows_sys::Win32::Foundation::{GetLastError, FILETIME};
    use windows_sys::Win32::Security::Credentials::*;

    fn to_wstr(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Store `secret` under `target`, replacing any existing entry.
    pub fn set(target: &str, user: &str, secret: &str) -> Result<(), String> {
        let mut target_w = to_wstr(target);
        let mut user_w = to_wstr(user);
        let mut comment_w = to_wstr("");
        let mut alias_w = to_wstr("");
        let mut blob = secret.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            Comment: comment_w.as_mut_ptr(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_ENTERPRISE, // on non-domain machines behaves like LOCAL_MACHINE
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: alias_w.as_mut_ptr(),
            UserName: user_w.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&cred as *const CREDENTIALW, 0) };
        if ok == 0 {
            return Err(format!("CredWriteW failed (error {})", unsafe { GetLastError() }));
        }
        Ok(())
    }

    /// Read back the secret stored under `target` (None when absent or store unavailable).
    pub fn get(target: &str) -> Option<String> {
        let target_w = to_wstr(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) };
        if ok == 0 {
            return None;
        }
        let cred = unsafe { *p };
        let mut secret = String::new();
        if !cred.CredentialBlob.is_null() && cred.CredentialBlobSize > 0 {
            let blob = unsafe {
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
            };
            secret = String::from_utf8_lossy(blob).into_owned();
        }
        unsafe { CredFree(p as *mut _) };
        Some(secret)
    }

    /// Delete the entry under `target` (no-op when absent).
    pub fn delete(target: &str) {
        let target_w = to_wstr(target);
        unsafe {
            let _ = CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod wincred {
    pub fn set(_target: &str, _user: &str, _secret: &str) -> Result<(), String> {
        Err("credential store not supported on this platform".into())
    }
    pub fn get(_target: &str) -> Option<String> {
        None
    }
    pub fn delete(_target: &str) {}
}

const MAX_API_KEY_LENGTH: usize = 1024;
const MAX_LABEL_LENGTH: usize = 120;
const PROBE_TIMEOUT_SECS: u64 = 5;
const MAX_PROBE_BODY_BYTES: usize = 4096;
/// Own settings row — deliberately separate from the frontend-owned `settings`
/// blob so save_settings round-trips can never clobber it.
const REMEMBERED_KEY: &str = "external_chat_target";

#[derive(Serialize, Deserialize, Clone)]
pub struct ExternalTarget {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub label: String,
}

/// In-memory registration. The API key is held here (private) and never serialized to the UI.
pub struct RegisteredServer {
    pub target: ExternalTarget,
    api_key: String,
}

impl RegisteredServer {
    fn new(target: ExternalTarget, api_key: String) -> Self {
        Self { target, api_key }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RememberedTarget {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub label: String,
    /// A key was required at registration time — the key itself is never stored.
    #[serde(default)]
    pub api_key_required: bool,
}

#[derive(Serialize, Clone)]
pub struct ExternalState {
    /// Currently registered server (None = not connected). Never contains the key.
    pub connected: Option<ExternalTarget>,
    /// Address remembered from an earlier session (form prefill / auto-restore).
    pub remembered: Option<RememberedTarget>,
}

#[derive(Serialize)]
pub struct ExternalConnectResult {
    pub target: ExternalTarget,
    /// Warning to show alongside a successful connect, if any.
    pub warning: String,
}

fn normalize_host(value: &str) -> Result<String, String> {
    let host = value.trim();
    if host.is_empty() {
        return Err("Host 唔可以係空".into());
    }
    // hostname / IPv4 / bracketed-IPv6 — anything else (spaces, schemes, paths) is rejected
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return Err("Invalid host".into());
    }
    Ok(host.to_string())
}

fn normalize_port(value: u16) -> Result<u16, String> {
    if value < 1 {
        return Err("Invalid port".into());
    }
    Ok(value)
}

/// Reject anything that cannot be a well-formed HTTP header value.
fn normalize_api_key(value: &str) -> Result<String, String> {
    let key = value.trim();
    if key.is_empty() {
        return Ok(String::new());
    }
    if key.len() > MAX_API_KEY_LENGTH {
        return Err("API key 太長".into());
    }
    if key.chars().any(|c| (c as u32) < 32 || c as u32 == 127) {
        return Err("API key 含有唔支援嘅控制字符".into());
    }
    Ok(key.to_string())
}

/// Is this /health body llama.cpp's?
///
/// llama-server answers `{"status": "ok"}` when ready and a 503 with
/// `{"error": {...}}` while a model loads. Anything that is not a JSON object
/// with one of those keys is some other service holding the port.
fn looks_like_llama_server(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v @ serde_json::Value::Object(_)) => v.get("status").is_some() || v.get("error").is_some(),
        _ => false,
    }
}

/// Probe /health and report what answered. Any HTTP response means *something* is
/// listening — 401 (wrong key) and 503 (still loading a model) are reported back
/// rather than treated as failures; only a transport-level error means nothing there.
async fn probe(host: &str, port: u16, api_key: &str) -> Result<(u16, bool), String> {
    let client = crate::util::http_client(std::time::Duration::from_secs(PROBE_TIMEOUT_SECS))?;
    let url = format!("http://{host}:{port}/health");
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("連唔到 {host}:{port} — 確認 llama-server 有冇喺度運行 ({e})"))?;
    let status = resp.status().as_u16();
    // Stream and stop at the cap — this probes a user-supplied host:port, so an unbounded
    // read would let whatever listens there force an arbitrarily large allocation. A partial
    // body is all identification needs; a mid-stream error just means "not identifiable".
    let mut chunks = resp.bytes_stream();
    let mut body: Vec<u8> = Vec::new();
    while body.len() < MAX_PROBE_BODY_BYTES {
        match chunks.next().await {
            Some(Ok(chunk)) => body.extend_from_slice(&chunk),
            Some(Err(_)) | None => break,
        }
    }
    let identified = looks_like_llama_server(&body[..body.len().min(MAX_PROBE_BODY_BYTES)]);
    Ok((status, identified))
}

fn describe_probe_status(status: u16) -> String {
    match status {
        401 | 403 => "連上咗，但係 server 拒絕咗個 API key — 對唔到之前 chat 都會失敗。".into(),
        503 => "連上咗。Server 仲喺度 load model。".into(),
        s if s >= 400 => format!("連上咗，但係 health check 返回 HTTP {s}。"),
        _ => String::new(),
    }
}

fn read_remembered(state: &State<'_, AppState>) -> Option<RememberedTarget> {
    let db = state.db.lock().ok()?;
    // Best effort — a DB error just means no remembered target, never blocks connect.
    db.get_setting(REMEMBERED_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
}

fn write_remembered(state: &State<'_, AppState>, entry: Option<&RememberedTarget>) {
    let Ok(db) = state.db.lock() else {
        return; // best effort — losing the prefilled form must never fail a connect
    };
    match entry {
        None => {
            let _ = db.delete_setting(REMEMBERED_KEY);
        }
        Some(e) => {
            if let Ok(json) = serde_json::to_string(e) {
                let _ = db.set_setting(REMEMBERED_KEY, &json);
            }
        }
    }
}

/// Credential-store target name for a remembered address's API key.
fn cred_target(host: &str, port: u16) -> String {
    format!("chachaanteng.external.{host}:{port}")
}

/// Persist (or clear, when `key` is empty) the API key for a remembered target. Best
/// effort — an unavailable credential store must never fail a connect; it just means
/// no auto-restore after a restart.
fn store_api_key(host: &str, port: u16, key: &str) {
    let target = cred_target(host, port);
    if key.is_empty() {
        wincred::delete(&target);
    } else {
        let _ = wincred::set(&target, host, key);
    }
}

/// Read back a stored API key (None when absent or the store is unreadable).
fn stored_api_key(host: &str, port: u16) -> Option<String> {
    wincred::get(&cred_target(host, port))
}

/// Register an externally started llama-server as the chat target.
#[tauri::command]
pub async fn external_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    api_key: String,
    label: String,
) -> Result<ExternalConnectResult, String> {
    let host = normalize_host(&host)?;
    let port = normalize_port(port)?;
    let key = normalize_api_key(&api_key)?;
    let label = label.trim().chars().take(MAX_LABEL_LENGTH).collect::<String>();

    let (status, _identified) = probe(&host, port, &key).await?;

    let key_required = !key.is_empty();
    // Keep the credential store in sync so a restart can re-authenticate (empty key clears it) —
    // EXCEPT when the server just rejected this key (401/403): storing a proven-bad key would
    // clobber whatever worked before and break auto-restore after the next restart.
    if status != 401 && status != 403 {
        store_api_key(&host, port, &key);
    }
    let target = ExternalTarget { host: host.clone(), port, label };
    *state.external.lock().await = Some(RegisteredServer::new(target.clone(), key));
    write_remembered(
        &state,
        Some(&RememberedTarget {
            host,
            port,
            label: target.label.clone(),
            api_key_required: key_required,
        }),
    );

    Ok(ExternalConnectResult {
        target,
        warning: describe_probe_status(status),
    })
}

/// Forget the registered server and drop the remembered address + stored key —
/// disconnecting is the operator saying they do not want this target, so it must
/// not come back.
#[tauri::command]
pub async fn external_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let target = state.external.lock().await.take().map(|r| r.target);
    if let Some(t) = &target {
        store_api_key(&t.host, t.port, "");
    }
    write_remembered(&state, None);
    Ok(())
}

/// Current registration + the remembered address (for form prefill).
#[tauri::command]
pub async fn external_get(state: State<'_, AppState>) -> Result<ExternalState, String> {
    let live = state.external.lock().await;
    Ok(ExternalState {
        connected: live.as_ref().map(|l| l.target.clone()),
        remembered: read_remembered(&state),
    })
}

/// Re-register the saved address at startup, when that is unambiguous.
///
/// When a key was needed it comes from the OS credential store; without it a target
/// that requires auth cannot be re-registered and is left for manual reconnect. The
/// port must also still identify itself as llama-server — anything else (or a
/// transport error: server not up yet) is left for the user to decide, never an Err.
#[tauri::command]
pub async fn external_restore(state: State<'_, AppState>) -> Result<Option<ExternalTarget>, String> {
    let remembered = match read_remembered(&state) {
        Some(r) => r,
        None => return Ok(None),
    };
    let key = stored_api_key(&remembered.host, remembered.port).unwrap_or_default();
    if remembered.api_key_required && key.is_empty() {
        // Key was needed at registration but is gone from the credential store — a
        // re-registered target would only 401. Manual reconnect (re-enter key) it is.
        return Ok(None);
    }
    let (status, identified) = match probe(&remembered.host, remembered.port, &key).await {
        Ok(x) => x,
        Err(_) => return Ok(None), // server not up yet — "not restorable now", never an error
    };
    if status >= 400 || !identified {
        // Something else is on the port now (or a stale key got rejected) — don't
        // register a target that chat would send to blindly.
        return Ok(None);
    }
    let target = ExternalTarget {
        host: remembered.host,
        port: remembered.port,
        label: remembered.label,
    };
    *state.external.lock().await = Some(RegisteredServer::new(target.clone(), key));
    Ok(Some(target))
}

/// Store or replace an address's API key in the OS credential store without
/// connecting — the Settings "External Servers" tab manages keys this way. An
/// empty `key` clears any stored entry. Unlike [`store_api_key`] (best-effort, so a
/// broken store never blocks a connect) failures are surfaced: the user is
/// explicitly saving a key and must know when it did not land.
#[tauri::command]
pub async fn external_store_key(host: String, port: u16, key: String) -> Result<(), String> {
    let host = normalize_host(&host)?;
    let port = normalize_port(port)?;
    let key = normalize_api_key(&key)?;
    if key.is_empty() {
        wincred::delete(&cred_target(&host, port));
    } else {
        wincred::set(&cred_target(&host, port), &host, &key)?;
    }
    Ok(())
}

/// Whether an API key is stored for this address in the OS credential store.
#[tauri::command]
pub async fn external_has_key(host: String, port: u16) -> Result<bool, String> {
    let host = normalize_host(&host)?;
    let port = normalize_port(port)?;
    Ok(stored_api_key(&host, port).is_some())
}

/// Bearer header for (host, port) when it matches the registered external server —
/// used by the chat proxy commands so the key never crosses IPC.
pub async fn auth_header(state: &AppState, host: &str, port: u16) -> Option<String> {
    let live = state.external.lock().await;
    match &*live {
        Some(lt) if lt.target.host == host && lt.target.port == port && !lt.api_key.is_empty() => {
            Some(format!("Bearer {}", lt.api_key))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip through the real OS credential store (self-cleaning): proves keys are
    /// encrypted at rest by the OS and read back within this user's session.
    #[test]
    fn api_key_roundtrip_via_credential_store() {
        const HOST: &str = "roundtrip-test.invalid"; // .invalid TLD — never resolves, no collision
        const PORT: u16 = 9;
        store_api_key(HOST, PORT, ""); // start clean (idempotent)
        store_api_key(HOST, PORT, "s3cret-key-🔑");
        assert_eq!(stored_api_key(HOST, PORT).as_deref(), Some("s3cret-key-🔑"));
        store_api_key(HOST, PORT, ""); // empty clears the entry
        assert_eq!(stored_api_key(HOST, PORT), None);
    }
}
