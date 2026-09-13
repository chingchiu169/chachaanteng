//! FR5 — benchmark runner (llama-bench / llama-perplexity) + WikiText-2 dataset.
//!
//! The benchmark tools live next to `llama-server.exe` in the engine folder, so
//! callers pass the server exe path and we resolve the sibling binary. One
//! benchmark runs at a time; output streams to a ring buffer (restorable across
//! tab switches) and is emitted live as `bench-output` events.

use crate::util::now_ms;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const LOG_CAP: usize = 4096;

/// Shared ring buffer of benchmark output lines.
pub type BenchLogBuffer = Arc<Mutex<VecDeque<String>>>;

pub struct BenchRun {
    pub tool: String,
    pub pid: u32,
    pub started_at_ms: i64,
    pub logs: BenchLogBuffer,
}

#[derive(Serialize, Clone)]
pub struct BenchStatus {
    pub tool: String,
    pub pid: u32,
    pub started_at_ms: i64,
}

/// Spawn a pipe-reader task: tag each line with `prefix`, push to the ring buffer, emit.
fn spawn_bench_pipe(
    app: AppHandle,
    logs: Arc<Mutex<VecDeque<String>>>,
    stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    prefix: &'static str,
) -> tokio::task::JoinHandle<()> {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(stream).lines();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let tagged = if prefix.is_empty() { line } else { format!("{prefix}{line}") };
            crate::util::push_capped(&logs, tagged.clone(), LOG_CAP);
            let _ = app.emit("bench-output", serde_json::json!({ "line": tagged }));
        }
    })
}

/// FR5.1/FR5.2 — spawn a benchmark tool with a fully-built argument list.
#[tauri::command]
pub async fn bench_start(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    engine_exe: String,
    tool: String,
    args: Vec<String>,
) -> Result<BenchStatus, String> {
    if tool != "llama-bench" && tool != "llama-perplexity" {
        return Err(format!("Unsupported benchmark tool: {tool}"));
    }
    if state.bench.lock().await.is_some() {
        return Err("A benchmark is already running.".into());
    }

    let exe = std::path::Path::new(&engine_exe)
        .parent()
        .ok_or_else(|| "Engine path has no parent directory".to_string())?
        .join(format!("{tool}.exe"));
    if !exe.is_file() {
        return Err(format!(
            "{} not found next to the engine ({}).",
            tool,
            exe.display()
        ));
    }

    let mut cmd = tokio::process::Command::new(exe);
    crate::util::hide_console_tokio(&mut cmd);
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start {tool}: {e}"))?;

    let pid = child.id().unwrap_or(0);
    let started_at_ms = now_ms();
    let logs: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAP)));

    // Claim the slot before spawning any tasks — a concurrent start that loses this race
    // kills its own child and returns, so no orphaned process or phantom exit event.
    {
        let mut slot = state.bench.lock().await;
        if slot.is_some() {
            crate::engine::kill_pid_async(pid).await;
            return Err("A benchmark is already running.".into());
        }
        *slot = Some(BenchRun { tool: tool.clone(), pid, started_at_ms, logs: logs.clone() });
    }

    // A fresh run supersedes the previous one's buffer — only once this run has actually claimed
    // the slot, so a failed start (missing exe / spawn error) keeps the old logs readable.
    *state.bench_last_logs.lock().await = None;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // stdout reader — benchmark tables/progress go here.
    let stdout_task = spawn_bench_pipe(app.clone(), logs.clone(), stdout, "");
    // stderr reader — errors + some progress on Windows.
    let stderr_task = spawn_bench_pipe(app.clone(), logs.clone(), stderr, "[err] ");

    // Waiter: free the slot + notify the UI when the process exits on its own (own Arc clone).
    {
        let app_c = app.clone();
        let bench_w = state.bench.clone();
        let last_logs_w = state.bench_last_logs.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            // Drain the pipes BEFORE notifying: the process can exit while its final
            // lines (the t/s summary table) are still buffered in the pipe, and the UI
            // extracts results as soon as "bench-exited" arrives.
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            let code = status.and_then(|s| s.code());
            // Keep the ring buffer readable after the slot frees — the UI pulls it on exit.
            if let Some(run) = bench_w.lock().await.take() {
                *last_logs_w.lock().await = Some(run.logs);
            }
            let _ = app_c.emit("bench-exited", serde_json::json!({ "code": code }));
        });
    }

    Ok(BenchStatus { tool, pid, started_at_ms })
}

/// Stop the running benchmark (process tree).
#[tauri::command]
pub async fn bench_stop(state: State<'_, crate::AppState>) -> Result<(), String> {
    let run = state.bench.lock().await.take().ok_or("No benchmark is running.")?;
    // Promote the ring buffer before freeing the slot — a manually stopped run keeps its logs
    // readable via get_bench_logs, same as a natural exit (the waiter's take() then sees None).
    *state.bench_last_logs.lock().await = Some(run.logs);
    crate::engine::kill_pid_async(run.pid).await;
    Ok(())
}

#[tauri::command]
pub async fn bench_status(state: State<'_, crate::AppState>) -> Result<Option<BenchStatus>, String> {
    Ok(state.bench.lock().await.as_ref().map(|r| BenchStatus {
        tool: r.tool.clone(),
        pid: r.pid,
        started_at_ms: r.started_at_ms,
    }))
}

/// Ring-buffer contents — restores the terminal after a tab switch. Falls back to
/// the most recently finished run's buffer once the slot has been freed.
#[tauri::command]
pub async fn get_bench_logs(state: State<'_, crate::AppState>) -> Result<Vec<String>, String> {
    if let Some(run) = state.bench.lock().await.as_ref() {
        return Ok(run.logs.lock().map(|q| q.iter().cloned().collect()).unwrap_or_default());
    }
    Ok(state
        .bench_last_logs
        .lock()
        .await
        .as_ref()
        .map(|logs| logs.lock().map(|q| q.iter().cloned().collect()).unwrap_or_default())
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------
// FR5.2 — WikiText-2 raw test file (auto-download for perplexity runs)
// ---------------------------------------------------------------------------

const WIKITEXT2_URL: &str =
    "https://huggingface.co/datasets/ggml-org/ci/resolve/main/wikitext-2-raw-v1.zip";
const WIKITEXT2_DIR: &str = "wikitext-2-raw-v1";
const WIKITEXT2_TEST_FILE: &str = "wiki.test.raw";

#[derive(Serialize, Clone)]
pub struct WikitextResult {
    pub ready: bool,
    /// True when this call performed the download (false if it already existed).
    pub downloaded: bool,
    pub path: String,
}

/// Ensure `models_dir/wikitext-2-raw-v1/wiki.test.raw` exists, downloading +
/// extracting from the ggml-org CI dataset zip when needed. Extraction goes to a
/// `.part` sibling first so an interrupted run can't leave a truncated file that
/// passes the existence check forever after.
#[tauri::command]
pub async fn ensure_wikitext2(
    app: AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<WikitextResult, String> {
    // Scope the db guard to a block — it must not live across an await (not Send).
    let models_dir = {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        crate::hf::get_models_dir(&app, &db)?
    };

    let dataset_dir = models_dir.join(WIKITEXT2_DIR);
    let target = dataset_dir.join(WIKITEXT2_TEST_FILE);
    if target.is_file() {
        return Ok(WikitextResult { ready: true, downloaded: false, path: target.to_string_lossy().into_owned() });
    }

    tokio::fs::create_dir_all(&dataset_dir).await.map_err(|e| e.to_string())?;

    // Download the zip to a temp file (streaming, size-verified). connect + read(stall) only —
    // a total `.timeout()` would cap the whole fetch and fail on slow links.
    let client = crate::util::http_client_streaming(std::time::Duration::from_secs(60))?;
    let resp = client.get(WIKITEXT2_URL).send().await.map_err(|e| format!("WikiText-2 download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading WikiText-2", resp.status()));
    }
    let expected = crate::util::declared_content_length(&resp);

    // unique per call so concurrent ensure_wikitext2 calls don't share/delete each other's zip
    let tmp_zip = std::env::temp_dir().join(format!("wikitext2-{}-{}.zip", std::process::id(), now_ms()));
    {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp_zip).await.map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        while let Some(chunk) = stream.next().await {
            // Any failure in this block must remove the partial zip — a bare `?` would leak it.
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp_zip).await;
                    return Err(format!("WikiText-2 download interrupted: {e}"));
                }
            };
            if let Err(e) = file.write_all(&chunk).await {
                let _ = tokio::fs::remove_file(&tmp_zip).await;
                return Err(e.to_string());
            }
            downloaded += chunk.len() as u64;
        }
        if let Some(exp) = expected {
            if downloaded != exp {
                let _ = tokio::fs::remove_file(&tmp_zip).await;
                return Err(format!(
                    "WikiText-2 zip download was incomplete: got {downloaded} bytes, expected {exp}."
                ));
            }
        }
    }

    // Extract wiki.test.raw (in-memory — the file is ~1 MB). Blocking IO runs off the async runtime.
    // Unique per call like tmp_zip — a fixed shared .part path let concurrent ensure_wikitext2
    // calls overwrite each other's extraction mid-flight.
    let part = target.with_file_name(format!("{}.{}-{}.part", WIKITEXT2_TEST_FILE, std::process::id(), now_ms()));
    let part_w = part.clone();
    let tmp_zip_w = tmp_zip.clone();
    let result = match tokio::task::spawn_blocking(move || {
        let zip_bytes = std::fs::read(&tmp_zip_w).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| e.to_string())?;
        let suffix = format!("/{WIKITEXT2_TEST_FILE}");
        let idx = (0..archive.len()).find(|&i| {
            archive
                .by_index(i)
                .ok()
                .map(|f| {
                    let name = f.name().replace('\\', "/");
                    name == WIKITEXT2_TEST_FILE || name.ends_with(&suffix)
                })
                .unwrap_or(false)
        });
        let idx = idx.ok_or_else(|| "WikiText-2 test file was not found in the downloaded archive.".to_string())?;
        let mut entry = archive.by_index(idx).map_err(|e| e.to_string())?;
        let expected_size = entry.size();
        let mut buf: Vec<u8> = Vec::with_capacity(expected_size as usize);
        std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
        if (buf.len() as u64) != expected_size {
            return Err(format!(
                "WikiText-2 extraction was short: got {} bytes, expected {expected_size}.",
                buf.len()
            ));
        }
        std::fs::write(&part_w, &buf).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    {
        // A panicked task still leaves the temp zip behind — clean it before reporting.
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_zip).await;
            return Err(format!("WikiText-2 extraction task failed: {e}"));
        }
        Ok(r) => r,
    };
    let _ = tokio::fs::remove_file(&tmp_zip).await; // always clean the temp zip

    match result {
        Ok(()) => {
            tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
            Ok(WikitextResult { ready: true, downloaded: true, path: target.to_string_lossy().into_owned() })
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}
