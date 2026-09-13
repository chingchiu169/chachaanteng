//! FR6.3 — live llama-server telemetry proxies (Prometheus /metrics, /slots, /props).
//!
//! Thin read-only fetches against a loopback server the app launched; short
//! timeouts so a dead/slow server degrades to an error string the UI can show.

use serde_json::Value;
use std::sync::LazyLock;
use std::time::Duration;

/// One shared client for all three proxies — the frontend polls them per server every 2 s, so
/// building a fresh Client (new connection pool + background task) on each call was pure waste.
/// The builder only sets fixed timeouts, so it cannot fail at runtime.
static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| crate::util::http_client(Duration::from_secs(5)).expect("build reqwest client"));

/// Raw Prometheus text from `GET /metrics` (requires the server to run with --metrics).
#[tauri::command]
pub async fn server_metrics(port: u16) -> Result<String, String> {
    let resp = CLIENT
        .get(format!("http://127.0.0.1:{port}/metrics"))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server on port {port}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Server returned {} for /metrics (is --metrics enabled?)",
            resp.status()
        ));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Slot table from `GET /slots`.
#[tauri::command]
pub async fn server_slots(port: u16) -> Result<Value, String> {
    let v: Value = CLIENT
        .get(format!("http://127.0.0.1:{port}/slots"))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server on port {port}: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Server properties from `GET /props` (model name, n_ctx, backends…).
#[tauri::command]
pub async fn server_props(port: u16) -> Result<Value, String> {
    let v: Value = CLIENT
        .get(format!("http://127.0.0.1:{port}/props"))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server on port {port}: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v)
}
