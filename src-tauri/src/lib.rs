mod bench;
mod builds;
mod chat;
mod db;
mod engine;
mod external;
mod fit;
mod gitupdate;
mod hf;
mod hw;
mod metrics;
mod presets;
mod process_stats;
mod system_stats;
mod tunnel;
mod util;
mod websearch;

use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub struct AppState {
    pub servers: Arc<tokio::sync::Mutex<HashMap<u16, engine::ServerEntry>>>,
    pub chat_cancel: tokio::sync::Mutex<Option<CancellationToken>>,
    /// rusqlite::Connection is Send but not Sync — wrap for Tauri managed state
    pub db: std::sync::Mutex<db::Db>,
    /// HF download progress (single concurrent download)
    pub hf_download: Arc<tokio::sync::Mutex<hf::HfDownloadState>>,
    /// Active cancel token for the running HF download, if any
    pub hf_cancel: tokio::sync::Mutex<Option<CancellationToken>>,
    /// Running benchmark (llama-bench / llama-perplexity), if any
    pub bench: Arc<tokio::sync::Mutex<Option<bench::BenchRun>>>,
    /// Ring buffer of the most recently finished run — kept readable after the slot frees.
    pub bench_last_logs: Arc<tokio::sync::Mutex<Option<bench::BenchLogBuffer>>>,
    /// System stats cache + CPU delta baseline (FR6.1/FR6.2)
    pub sys_stats: tokio::sync::Mutex<system_stats::SysStatsCache>,
    /// FR8.3 — externally registered llama-server as chat target (session-scoped; the API key lives inside and never crosses IPC)
    pub external: Arc<tokio::sync::Mutex<Option<external::RegisteredServer>>>,
    /// FR8.1 — Cloudflare quick tunnel state (status machine + cloudflared PID)
    pub tunnel: Arc<tokio::sync::Mutex<tunnel::TunnelState>>,
}

/// Write a UTF-8 text file (used for preset .cmd shortcut export).
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') {
        return Err("Invalid path".into());
    }
    tokio::fs::write(&path, contents).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(data_dir.join("chachaanteng.db")).map_err(|e| e.to_string())?;
            // Housekeeping — prune server logs past the configured retention (0 = keep everything).
            if let Ok(Some(json)) = db.get_setting("settings") {
                if let Ok(s) = serde_json::from_str::<db::Settings>(&json) {
                    if s.log_retention_days > 0 {
                        let _ = engine::prune_server_logs(app.handle(), s.log_retention_days);
                    }
                }
            }
            app.manage(AppState {
                servers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                chat_cancel: tokio::sync::Mutex::new(None),
                db: std::sync::Mutex::new(db),
                hf_download: Arc::new(tokio::sync::Mutex::new(hf::HfDownloadState::default())),
                hf_cancel: tokio::sync::Mutex::new(None),
                bench: Arc::new(tokio::sync::Mutex::new(None)),
                bench_last_logs: Arc::new(tokio::sync::Mutex::new(None)),
                sys_stats: tokio::sync::Mutex::new(system_stats::SysStatsCache::default()),
                external: Arc::new(tokio::sync::Mutex::new(None)),
                tunnel: Arc::new(tokio::sync::Mutex::new(tunnel::TunnelState::default())),
            });
            // Reconnect to llama-server processes that outlived the previous session.
            {
                let handle = app.handle().clone();
                let servers = app.state::<AppState>().servers.clone();
                tauri::async_runtime::spawn(async move {
                    engine::adopt_orphan_servers(handle, servers).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            builds::get_onboarding_data,
            builds::install_build,
            builds::validate_custom_engine,
            builds::list_installed_engines,
            builds::delete_installed_engine,
            builds::list_engine_versions,
            engine::launch_server,
            engine::stop_server,
            engine::list_servers,
            engine::get_server_logs,
            engine::list_server_logs,
            engine::read_server_log,
            engine::delete_server_log,
            engine::server_health,
            fit::estimate_memory,
            chat::chat_stream,
            chat::stop_chat,
            chat::context_capacity,
            chat::measure_prompt_tokens,
            chat::tokenize_count,
            chat::read_attachment,
            external::external_connect,
            external::external_disconnect,
            external::external_get,
            external::external_restore,
            external::external_store_key,
            external::external_has_key,
            db::get_settings,
            db::save_settings,
            db::get_flag_values,
            db::save_flag_values,
            db::get_model_overrides,
            db::set_model_override,
            db::list_conversations,
            db::get_messages,
            db::save_conversation,
            db::append_message,
            db::rename_conversation,
            db::delete_conversation,
            websearch::web_search,
            websearch::open_url,
            presets::list_presets,
            presets::save_preset,
            presets::rename_preset,
            presets::delete_preset,
            presets::archive_presets,
            hf::hf_list_repo_files,
            hf::hf_search_models,
            hf::hf_model_info,
            hf::hf_start_download,
            hf::hf_cancel_download,
            hf::hf_get_download_status,
            hf::get_models_dir_info,
            hf::list_local_models,
            hf::delete_local_model,
            hf::delete_model_file,
            bench::bench_start,
            bench::bench_stop,
            bench::bench_status,
            bench::get_bench_logs,
            bench::ensure_wikitext2,
            system_stats::get_system_stats,
            metrics::server_metrics,
            metrics::server_slots,
            metrics::server_props,
            process_stats::server_process_stats,
            tunnel::tunnel_status,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            gitupdate::git_update_status,
            gitupdate::git_pull,
            gitupdate::restart_app,
            write_text_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill any orphaned llama-server / benchmark processes on exit
                let state = app_handle.state::<AppState>();
                // Skip re-adopted (externally started) servers — they outlived the previous app
                // session on purpose; killing them here would surprise the user. They get
                // re-adopted next launch if still running.
                for entry in state.servers.blocking_lock().values() {
                    if entry.reconnected {
                        continue;
                    }
                    engine::kill_pid(entry.pid);
                }
                {
                    let bench = state.bench.blocking_lock();
                    if let Some(run) = bench.as_ref() {
                        engine::kill_pid(run.pid);
                    }
                }
                // FR8.1 — kill the cloudflared tunnel too, so no orphaned quick tunnels linger
                {
                    let t = state.tunnel.blocking_lock();
                    if let Some(pid) = t.child_pid() {
                        engine::kill_pid(pid);
                    }
                }
            }
        });
}
