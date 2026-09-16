//! FR8.1 — Cloudflare quick tunnel exposing a local llama-server to the public internet.
//!
//! On first use we download `cloudflared` (SHA-256 verified against GitHub's release metadata) into
//! app_data/cloudflared/, then run `cloudflared tunnel --url http://127.0.0.1:<port>` and scrape the
//! ephemeral trycloudflare.com URL from its stderr. The tunnel is session-scoped: it dies with the app,
//! and every start gets a fresh random URL (same semantics as the reference implementation).

use crate::util::hex_of;
use crate::AppState;
use futures_util::StreamExt;
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const RELEASE_API: &str = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const ASSET_NAME: &str = if cfg!(windows) {
    "cloudflared-windows-amd64.exe"
} else if cfg!(target_arch = "aarch64") {
    "cloudflared-darwin-arm64"
} else {
    "cloudflared-darwin-amd64"
};
/// Local binary name (no .exe on macOS).
const BIN_NAME: &str = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
/// Keep only the most recent N stderr lines in memory (the UI shows a tail).
const LOG_LIMIT: usize = 200;

#[derive(Serialize, Clone)]
pub struct TunnelSnapshot {
    /// idle | preparing | downloading | starting | running | stopped | error
    pub status: String,
    /// https://xxx.trycloudflare.com once up ("" otherwise)
    pub url: String,
    pub message: String,
    pub log: Vec<String>,
}

pub struct TunnelState {
    pub status: String,
    pub url: String,
    pub message: String,
    pub log: Vec<String>,
    /// PID of the running cloudflared (killed via kill_pid on stop/exit) — None when not running.
    child_pid: Option<u32>,
    cancel: Option<CancellationToken>,
}

impl Default for TunnelState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            url: String::new(),
            message: String::new(),
            log: Vec::new(),
            child_pid: None,
            cancel: None,
        }
    }
}

impl TunnelState {
    /// PID of the running cloudflared, for the app-exit cleanup in lib.rs.
    pub fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }
}

fn snapshot(s: &TunnelState) -> TunnelSnapshot {
    TunnelSnapshot {
        status: s.status.clone(),
        url: s.url.clone(),
        message: s.message.clone(),
        log: s.log.clone(),
    }
}

fn push_log(state: &mut TunnelState, line: String) {
    state.log.push(line);
    if state.log.len() > LOG_LIMIT {
        let drop = state.log.len() - LOG_LIMIT;
        state.log.drain(0..drop);
    }
}

/// Set status/message on the shared tunnel state (worker + commands share this).
async fn update(st: &tokio::sync::Mutex<TunnelState>, status: Option<&str>, message: Option<&str>) {
    let mut s = st.lock().await;
    if let Some(x) = status {
        s.status = x.into();
    }
    if let Some(m) = message {
        s.message = m.into();
    }
}

/// Locate the cloudflared binary under app_data/cloudflared/, downloading + SHA-256 verifying on first use.
async fn ensure_cloudflared(
    st: &tokio::sync::Mutex<TunnelState>,
    data_dir: &Path,
    cancel: &CancellationToken,
) -> Result<PathBuf, String> {
    let dir = data_dir.join("cloudflared");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("無法建立 cloudflared 目錄: {e}"))?;
    let bin = dir.join(BIN_NAME);
    if bin.exists() {
        return Ok(bin);
    }

    let msg = format!("下載 cloudflared ({ASSET_NAME})…");
    update(st, Some("downloading"), Some(&msg)).await;

    // Same client serves the metadata fetch and the streaming download — connect + read(stall) timeouts only.
    let client = &crate::util::STREAM_CLIENT;
    // Release metadata carries each asset's digest as "sha256:<hex>" — verify against it.
    let rel: serde_json::Value = client
        .get(RELEASE_API)
        .header("User-Agent", "chachaanteng")
        .send()
        .await
        .map_err(|e| format!("fetch GitHub release 失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse release metadata 失敗: {e}"))?;
    let assets = rel
        .pointer("/assets")
        .and_then(|a| a.as_array())
        .ok_or("release metadata 冇 assets")?;
    let asset = assets
        .iter()
        .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(ASSET_NAME))
        .ok_or_else(|| format!("release 入面搵唔到 {ASSET_NAME}"))?;
    let expected = asset
        .get("digest")
        .and_then(|d| d.as_str())
        .map(str::to_lowercase)
        .and_then(|d| d.strip_prefix("sha256:").map(str::to_string))
        .ok_or("asset 冇 sha256 digest")?;
    let download_url = asset
        .get("browser_download_url")
        .and_then(|u| u.as_str())
        .filter(|u| !u.is_empty())
        .ok_or("asset 冇 browser_download_url")?
        .to_string();

    // Stream to a staging file while hashing, then verify before promoting to cloudflared.exe.
    let staging = dir.join(format!("{ASSET_NAME}.part"));
    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下載 cloudflared 失敗: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下載 cloudflared 失敗 (HTTP {})", resp.status()));
    }
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(&staging)
        .await
        .map_err(|e| format!("建立暫存檔失敗: {e}"))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        // Stop clicked mid-download — bail before writing more (run_tunnel sees the cancel and exits).
        if cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&staging).await;
            return Err("下載已停止".into());
        }
        // Any failure in this block must remove the partial staging file — a bare `?` would leak it.
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = tokio::fs::remove_file(&staging).await;
                return Err(format!("下載中斷: {e}"));
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(e.to_string());
        }
    }
    drop(file);
    let computed = hex_of(hasher.finalize());
    if computed != expected {
        let _ = tokio::fs::remove_file(&staging).await;
        return Err("cloudflared SHA-256 校驗失敗 — 下載檔案同 GitHub release 唔匹配".into());
    }
    tokio::fs::rename(&staging, &bin)
        .await
        .map_err(|e| format!("move {BIN_NAME} 失敗: {e}"))?;
    // Don't rely on the downloaded file's mode bits — cloudflared must be executable.
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).await;
    }
    Ok(bin)
}

/// The tunnel worker: ensure binary → spawn cloudflared → scrape the URL from stderr.
async fn run_tunnel(
    st: Arc<tokio::sync::Mutex<TunnelState>>,
    data_dir: PathBuf,
    port: u16,
    cancel: CancellationToken,
) {
    update(&st, Some("preparing"), Some("檢查 cloudflared…")).await;

    let bin = match ensure_cloudflared(&st, &data_dir, &cancel).await {
        Ok(_) if cancel.is_cancelled() => return, // stop clicked mid-download — don't spawn a zombie tunnel
        Ok(b) => b,
        Err(_) if cancel.is_cancelled() => return,
        Err(e) => {
            update(&st, Some("error"), Some(&e)).await;
            return;
        }
    };

    let msg = format!("啟動 tunnel → http://127.0.0.1:{port}…");
    update(&st, Some("starting"), Some(&msg)).await;

    let mut cmd = Command::new(&bin);
    crate::util::hide_console_tokio(&mut cmd);
    cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) if cancel.is_cancelled() => return,
        Err(e) => {
            update(&st, Some("error"), Some(&format!("啟動 cloudflared 失敗: {e}"))).await;
            return;
        }
    };

    // Register the PID so tunnel_stop / app-exit can taskkill it.
    let pid = child.id().unwrap_or(0);
    {
        let mut s = st.lock().await;
        s.child_pid = Some(pid);
    }
    let stderr = child.stderr.take().expect("stderr piped");
    drop(child); // the OS process keeps running; we only need the pipe handle

    let url_re = Regex::new(r"https://[\w.-]+\.trycloudflare\.com").unwrap();
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    loop {
        // tokio 1.53's Lines no longer implements Stream — use the inherent next_line().
        tokio::select! {
            _ = cancel.cancelled() => return, // tunnel_stop already set the status
            res = lines.next_line() => match res {
                Ok(Some(l)) => {
                    let mut s = st.lock().await;
                    push_log(&mut s, l.clone());
                    if s.url.is_empty() {
                        if let Some(m) = url_re.find(&l) {
                            s.status = "running".into();
                            s.url = m.as_str().to_string();
                            s.message.clear();
                        }
                    }
                }
                Ok(None) | Err(_) => break, // process exited (EOF) or read error
            },
        }
    }

    if cancel.is_cancelled() {
        return; // stop path owns the status
    }
    let (had_url, tail) = {
        let mut s = st.lock().await;
        // Natural exit — clear the PID so the app-exit handler can't taskkill a recycled one.
        s.child_pid = None;
        let last: Vec<&str> = s.log.iter().rev().take(3).map(String::as_str).collect();
        (!s.url.is_empty(), last.into_iter().rev().collect::<Vec<_>>().join(" | "))
    };
    if had_url {
        update(&st, Some("stopped"), Some("tunnel 斷咗 (cloudflared 退出)")).await;
    } else {
        let msg = format!("cloudflared 未拿到 URL 就退出咗: {tail}");
        update(&st, Some("error"), Some(&msg)).await;
    }
}

#[tauri::command]
pub async fn tunnel_status(state: State<'_, AppState>) -> Result<TunnelSnapshot, String> {
    let s = state.tunnel.lock().await;
    Ok(snapshot(&s))
}

#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    port: u16,
) -> Result<TunnelSnapshot, String> {
    let st = Arc::clone(&state.tunnel);
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // Scope the guard so it's dropped before `st` moves into the worker (E0505 otherwise).
    let (cancel, snap) = {
        let mut s = st.lock().await;
        if matches!(s.status.as_str(), "preparing" | "downloading" | "starting" | "running") {
            return Ok(snapshot(&s)); // already working — don't double-spawn
        }
        // Fresh run: clear the previous log, arm a cancel token. Set "preparing" here so the
        // snapshot returned to the UI already reflects the new run (the worker confirms it).
        s.log.clear();
        s.url.clear();
        s.status = "preparing".into();
        s.message = "檢查 cloudflared…".into();
        let cancel = CancellationToken::new();
        s.cancel = Some(cancel.clone());
        (cancel, snapshot(&s))
    };

    tokio::spawn(run_tunnel(st, data_dir, port, cancel));
    Ok(snap)
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>) -> Result<TunnelSnapshot, String> {
    // Take the cancel token + PID under a short lock; taskkill runs OUTSIDE it so the worker's
    // stderr loop isn't blocked behind the kill.
    let (cancel, pid) = {
        let mut s = state.tunnel.lock().await;
        (s.cancel.take(), s.child_pid.take())
    };
    if let Some(c) = cancel {
        c.cancel();
    }
    if let Some(pid) = pid {
        crate::engine::kill_pid_async(pid).await; // taskkill /F /T — kills the whole tree
    }
    let mut s = state.tunnel.lock().await;
    if !matches!(s.status.as_str(), "idle") {
        s.status = "stopped".into();
        s.message.clear();
    }
    Ok(snapshot(&s))
}
