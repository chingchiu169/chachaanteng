use crate::AppState;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{LineWriter, Write};
use std::marker::Unpin;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// Directory where per-session server logs are persisted (survives app restarts).
fn log_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// LineWriter (not BufWriter): flushes on every newline, so the file is current while the
/// server runs. A plain BufWriter held lines in its 8 KB buffer until process exit — a live
/// low-output session sat at 0 bytes on disk and looked dead from the Logs page.
type DiskLog = Arc<Mutex<LineWriter<File>>>;

fn write_disk_log(disk: &Option<DiskLog>, line: &str) {
    if let Some(w) = disk {
        if let Ok(mut g) = w.lock() {
            let _ = writeln!(g, "{line}");
        }
    }
}

pub struct ServerEntry {
    pub pid: u32,
    pub model_path: String,
    pub args_preview: String,
    pub logs: Arc<Mutex<VecDeque<String>>>,
    /// True when this entry was re-adopted from a process that outlived the previous app
    /// session — no stdout pipe exists for it, so live output is unavailable.
    pub reconnected: bool,
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub port: u16,
    pub model_path: String,
    pub reconnected: bool,
}

/// Ring-buffer cap for in-memory server logs.
const LOG_CAP: usize = 2048;

#[cfg(windows)]
pub fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    // taskkill /T terminates the whole process tree — the reliable way on Windows
    let mut cmd = std::process::Command::new("taskkill");
    crate::util::hide_console_std(&mut cmd);
    let _ = cmd.args(["/F", "/T", "/PID", &pid.to_string()]).output();
}

#[cfg(not(windows))]
pub fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    // llama-server / cloudflared spawn no children of their own, so a direct signal suffices.
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
}

/// Async-context variant of [kill_pid] — taskkill's duration is unbounded on a loaded system,
/// so it must not run on a tokio worker. The sync version stays for the app-exit handler in
/// lib.rs, which runs outside the runtime (spawn_blocking would panic there).
pub async fn kill_pid_async(pid: u32) {
    if pid == 0 {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || kill_pid(pid)).await;
}

/// Read a child's stdout/stderr line-by-line: ring buffer + disk log + IPC emit.
fn spawn_pipe<R>(
    app: AppHandle,
    port: u16,
    logs: Arc<Mutex<VecDeque<String>>>,
    disk: Option<DiskLog>,
    stream: R,
    prefix: &'static str,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(stream).lines();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            crate::util::push_capped(&logs, line.clone(), LOG_CAP);
            let tagged = if prefix.is_empty() { line } else { format!("{prefix}{line}") };
            write_disk_log(&disk, &tagged);
            let _ = app.emit(
                "server-log",
                serde_json::json!({ "port": port, "line": tagged }),
            );
        }
    });
}

/// Launch llama-server with a fully-built flag argument list (Quick Launch / Configure tabs).
/// `args` must already contain `-m <model>`; host/port are appended here.
#[tauri::command]
pub async fn launch_server(
    app: AppHandle,
    state: State<'_, AppState>,
    engine_exe: String,
    args: Vec<String>,
    port: u16,
) -> Result<ServerInfo, String> {
    spawn_server(app, state, engine_exe, args, port).await
}

/// Best-effort name of the process listening on `port` (for the occupied-port error message).
/// Runs off the tokio workers with a hard timeout — powershell's cold start alone can add seconds
/// to every occupied-port error, and the name is only cosmetic.
async fn port_holder(port: u16) -> Option<String> {
    let probe = async move {
        tokio::task::spawn_blocking(move || {
            #[cfg(not(windows))]
            {
                // -Fc emits one field per line prefixed by its letter; `c` = command name (full,
                // not truncated like the default table view). First listener wins.
                let out = std::process::Command::new("lsof")
                    .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fc"])
                    .output()
                    .ok()?;
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .find_map(|l| l.strip_prefix('c'))
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            }
            #[cfg(windows)]
            {
                let out = std::process::Command::new("powershell.exe")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            r#"(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess | ForEach-Object {{ (Get-Process -Id $_ -ErrorAction SilentlyContinue).Name }}"#
                        ),
                    ])
                    .output()
                    .ok()?;
                let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                (!name.is_empty()).then_some(name)
            }
        })
        .await
        .ok()?
    };
    match tokio::time::timeout(std::time::Duration::from_secs(5), probe).await {
        Ok(name) => name,
        Err(_) => None, // probe timed out — the holder's name is best-effort only
    }
}

async fn spawn_server(
    app: AppHandle,
    state: State<'_, AppState>,
    engine_exe: String,
    mut args: Vec<String>,
    port: u16,
) -> Result<ServerInfo, String> {
    let servers = state.servers.clone();
    {
        let guard = servers.lock().await;
        if guard.contains_key(&port) {
            return Err(format!("Port {port} 已經有 server 運行緊"));
        }
    }

    // Fast-fail when the port is held by something OUTSIDE our registry (e.g. an orphaned
    // server from a previous session): llama-server only binds after the model finishes
    // loading, so without this check a doomed launch wastes minutes of VRAM before dying.
    // Async connect — the std::net variant would block a tokio worker for up to 300 ms.
    // NOTE: timeout() resolves Ok(Err(refused)) for a CLOSED port (the refusal is instant), so
    // only an actually-completed CONNECT means the port is taken — checking the outer Result's
    // is_ok() would flag every free port as occupied.
    match tokio::time::timeout(
        std::time::Duration::from_millis(300),
        tokio::net::TcpStream::connect(std::net::SocketAddr::from(([127, 0, 0, 1], port))),
    )
    .await
    {
        Ok(Ok(_)) => {
            // Name the holder when we can — on macOS e.g. ControlCenter (AirPlay) owns 5000/7000,
            // and a bare "occupied by another program" gives no clue which port to avoid.
            let holder = port_holder(port).await;
            return Err(match holder {
                Some(h) => format!("Port {port} 已經被 {h} 佔用"),
                None => format!("Port {port} 已經被其他程序佔用"),
            });
        }
        // refused (free port) or no answer within the window — llama-server can still bind.
        _ => {}
    }

    // Model path for display: args already carry `-m <path>`
    let model_path = args
        .iter()
        .position(|a| a == "-m")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default();

    args.push("--host".into());
    args.push("127.0.0.1".into());
    args.push("--port".into());
    args.push(port.to_string());

    let mut cmd = tokio::process::Command::new(&engine_exe);
    crate::util::hide_console_tokio(&mut cmd);
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("啟動 llama-server 失敗: {e}"))?;

    let pid = child.id().unwrap_or(0);
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let logs: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAP)));

    // Claim the registry slot BEFORE creating the disk log or spawning pipe readers — a launch
    // that loses the port race must not leave an orphaned log file behind.
    let args_preview = format!("{} {}", engine_exe, args.join(" "));
    {
        let mut guard = servers.lock().await;
        if guard.contains_key(&port) {
            kill_pid_async(pid).await;
            return Err(format!("Port {port} 已經有 server 運行緊"));
        }
        guard.insert(
            port,
            ServerEntry {
                pid,
                model_path: model_path.clone(),
                args_preview: args_preview.clone(),
                logs: logs.clone(),
                reconnected: false,
            },
        );
    }

    // Disk log: one file per launch session so history survives app restarts.
    let disk_log: Option<DiskLog> = log_dir(&app)
        .ok()
        .and_then(|dir| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .write(true)
                .open(dir.join(format!(
                    "server-{port}-{}.log",
                    chrono::Local::now().format("%Y%m%d-%H%M%S")
                )))
                .ok()
                .map(LineWriter::new)
        })
        .map(|w| Arc::new(Mutex::new(w)));

    // stdout / stderr readers (stderr lines are tagged "[err]" on disk + IPC)
    spawn_pipe(app.clone(), port, logs.clone(), disk_log.clone(), stdout, "");
    spawn_pipe(app.clone(), port, logs.clone(), disk_log.clone(), stderr, "[err] ");

    // waiter: clean up entry when process exits on its own (own Arc clone)
    {
        let app_c = app.clone();
        let servers_w = state.servers.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            let code = status.and_then(|s| s.code());
            // Only remove + notify for our own entry: a manual stop already removed it,
            // and a concurrent launch on the same port may have replaced it.
            let removed_ours = {
                let mut guard = servers_w.lock().await;
                if guard.get(&port).map(|e| e.pid) == Some(pid) {
                    guard.remove(&port);
                    true
                } else {
                    false
                }
            };
            if removed_ours {
                let _ = app_c.emit(
                    "server-exited",
                    serde_json::json!({ "port": port, "code": code }),
                );
            }
        });
    }

    Ok(ServerInfo {
        port,
        model_path,
        reconnected: false,
    })
}

#[tauri::command]
pub async fn stop_server(state: State<'_, AppState>, port: u16) -> Result<(), String> {
    let entry = state
        .servers
        .lock()
        .await
        .remove(&port)
        .ok_or("冇運行緊嘅 server")?;
    kill_pid_async(entry.pid).await;
    Ok(())
}

/// Return the buffered log lines for a running server (ring buffer, newest last).
#[tauri::command]
pub async fn get_server_logs(
    state: State<'_, AppState>,
    port: u16,
) -> Result<Vec<String>, String> {
    let guard = state.servers.lock().await;
    match guard.get(&port) {
        Some(e) => {
            let q = e.logs.lock().unwrap_or_else(|p| p.into_inner());
            Ok(q.iter().cloned().collect())
        }
        None => Err(format!("Port {port} 冇運行緊嘅 server")),
    }
}

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> Result<Vec<ServerInfo>, String> {
    let guard = state.servers.lock().await;
    Ok(guard
        .iter()
        .map(|(port, e)| ServerInfo {
            port: *port,
            model_path: e.model_path.clone(),
            reconnected: e.reconnected,
        })
        .collect())
}

/// GET /health against a local server — used to verify re-adopted processes. The client is
/// built once by the caller (the janitor loops for the app's lifetime).
async fn health_ok(client: &reqwest::Client, port: u16) -> bool {
    matches!(
        client.get(format!("http://127.0.0.1:{port}/health")).send().await,
        Ok(r) if r.status().is_success()
    )
}

/// Last `--port <n>` in a command line (spawn_server appends host/port at the end).
static PORT_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"--port(?:=|\s+)(\d+)").unwrap());

fn parse_port(cmdline: &str) -> Option<u16> {
    let mut last = None;
    for m in PORT_RE.captures_iter(cmdline) {
        if let Some(d) = m.get(1).and_then(|g| g.as_str().parse::<u16>().ok()) {
            last = Some(d);
        }
    }
    last
}

/// Last `-m <path>` / `--model <path>` in a command line. The value may be quoted (Windows WMI
/// re-quotes args with spaces) or unquoted WITH embedded spaces (macOS ps prints argv verbatim, no
/// re-quoting); the unquoted form runs until the next flag token or end of line.
fn parse_model(cmdline: &str) -> Option<String> {
    let mut last = None;
    let mut from = 0usize;
    while let Some((flag_start, flag_len)) = find_model_flag(cmdline, from) {
        // Value starts after the flag: optional '=', then a quoted string or bare text.
        let mut rest = &cmdline[flag_start + flag_len..];
        if let Some(r2) = rest.strip_prefix('=') {
            rest = r2;
        }
        let t = rest.trim_start();
        let value = if let Some(q) = t.strip_prefix('"') {
            // Quoted — take everything up to the closing quote (or EOL when unbalanced).
            q.split_once('"').map(|(inner, _)| inner.to_string()).unwrap_or_else(|| q.to_string())
        } else {
            // Unquoted — runs until whitespace followed by a flag token ("-" + something) or EOL.
            let mut end = t.len();
            for (i, c) in t.char_indices() {
                if c.is_whitespace() && is_flag_after(&t[i..]) {
                    end = i;
                    break;
                }
            }
            t[..end].to_string()
        };
        last = Some(value);
        from = flag_start + flag_len; // keep scanning — a later -m wins (spawn order)
    }
    last
}

/// True when the text after some whitespace begins with a flag token ("-x" / "--xx").
fn is_flag_after(s: &str) -> bool {
    let t = s.trim_start();
    t.len() > 1 && t.starts_with('-')
}

/// Next "-m"/"--model" token at or after `from` as (byte start, flag length). The token must be
/// whitespace-bounded and followed by '=', whitespace, or EOL — so "--models" or a path component
/// named "-m" don't match.
fn find_model_flag(s: &str, from: usize) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for flag in ["-m", "--model"] {
        let mut search_from = from;
        while let Some(rel) = s[search_from..].find(flag) {
            let abs = search_from + rel;
            let at_boundary = abs == 0 || s.as_bytes()[abs - 1].is_ascii_whitespace();
            let after = abs + flag.len();
            let ok_after = after >= s.len()
                || s.as_bytes()[after] == b'='
                || s.as_bytes()[after].is_ascii_whitespace();
            if at_boundary && ok_after {
                if best.map_or(true, |b| abs < b.0) {
                    best = Some((abs, flag.len()));
                }
                break; // this flag kind is settled — the other kind is checked separately
            }
            search_from = abs + 1;
        }
    }
    best
}

/// (pid, port, model) parsed from the ConvertTo-Json process enumeration output.
#[cfg(windows)]
fn parse_process_rows(json: &str) -> Vec<(u32, u16, String)> {
    // WMI/Select-Object emit PascalCase keys — serde matches case-sensitively by default.
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(rename = "ProcessId")]
        pid: u32,
        #[serde(rename = "CommandLine")]
        commandline: Option<String>,
    }
    let rows: Vec<Row> = match serde_json::from_str(json) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.into_iter()
        .filter_map(|r| {
            let cmd = r.commandline?;
            Some((r.pid, parse_port(&cmd)?, parse_model(&cmd).unwrap_or_default()))
        })
        .collect()
}

/// (pid, port, model) for every running llama-server.exe with a parseable local port.
#[cfg(windows)]
fn enumerate_llama_server_processes() -> Vec<(u32, u16, String)> {
    // -InputObject forces ConvertTo-Json to emit an array even for a single row;
    // empty input prints nothing (handled below).
    let mut cmd = std::process::Command::new("powershell.exe");
    crate::util::hide_console_std(&mut cmd);
    let out = match cmd
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"$p = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Select-Object ProcessId, CommandLine); if ($p.Count) { ConvertTo-Json -InputObject $p }"#,
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    parse_process_rows(&text)
}

/// One `ps -o pid=,command=` line → (pid, port, model), or None when it isn't a local llama-server.
#[cfg(not(windows))]
fn parse_ps_line(line: &str) -> Option<(u32, u16, String)> {
    let mut it = line.split_whitespace();
    let pid: u32 = it.next()?.parse().ok()?;
    let cmd = it.collect::<Vec<_>>().join(" ");
    // argv[0] may contain spaces (".../Library/Application Support/engines/b10952-metal/llama-server"),
    // so a whitespace split can't recover it — walk the leading tokens up to the first flag and
    // match the binary name as a path component.
    let bin = crate::util::bin_name("llama-server");
    let mut is_llama = false;
    for tok in cmd.split(' ') {
        if tok.starts_with('-') {
            break; // reached the flags — argv[0] didn't match
        }
        if std::path::Path::new(tok).file_name().and_then(|f| f.to_str()) == Some(bin.as_str()) {
            is_llama = true;
            break;
        }
    }
    if !is_llama {
        return None;
    }
    Some((pid, parse_port(&cmd)?, parse_model(&cmd).unwrap_or_default()))
}

/// (pid, port, model) for every running llama-server with a parseable local port.
#[cfg(not(windows))]
fn enumerate_llama_server_processes() -> Vec<(u32, u16, String)> {
    // -axww = all processes, unlimited width (long model paths must not be truncated).
    let out = match std::process::Command::new("ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_ps_line)
        .collect()
}

/// Full command lines of every running llama-server — including ones this app did not start.
/// The server registry alone can't see external servers (their args_preview is empty), and on
/// Windows a locked exe would otherwise surface later as an opaque access-denied on rename/remove.
pub fn llama_server_cmdlines() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell.exe");
        crate::util::hide_console_std(&mut cmd);
        let out = match cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"$p = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Select-Object CommandLine); if ($p.Count) { ConvertTo-Json -InputObject $p }"#,
            ])
            .output()
        {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        // WMI/Select-Object emit PascalCase keys — serde matches case-sensitively by default.
        #[derive(serde::Deserialize)]
        struct CmdRow {
            #[serde(rename = "CommandLine")]
            commandline: Option<String>,
        }
        serde_json::from_str::<Vec<CmdRow>>(&String::from_utf8_lossy(&out.stdout))
            .map(|rows| rows.into_iter().filter_map(|r| r.commandline).collect())
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let out = match std::process::Command::new("ps")
            .args(["-axww", "-o", "command="])
            .output()
        {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        // argv[0] may contain spaces — walk the leading tokens up to the first flag and match the
        // binary name as a path component (same rule as parse_ps_line).
        let bin = crate::util::bin_name("llama-server");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|line| {
                line.split(' ')
                    .take_while(|t| !t.starts_with('-'))
                    .any(|tok| std::path::Path::new(tok).file_name().and_then(|f| f.to_str()) == Some(bin.as_str()))
            })
            .map(str::to_string)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn parses_real_wmi_output_shape() {
        // Captured verbatim from Get-CimInstance on the dev machine (2026-09-10):
        // PascalCase keys, null CommandLine for a process WMI won't disclose.
        let json = r#"[
            { "ProcessId": 17952, "CommandLine": null },
            { "ProcessId": 32824, "CommandLine": "\"C:\\engines\\llama-server.exe\" --host 127.0.0.1 --port 8080 -m C:\\models\\test.gguf" }
        ]"#;
        let rows = parse_process_rows(json);
        assert_eq!(rows.len(), 1, "null-CommandLine row must be skipped");
        assert_eq!(rows[0].0, 32824);
        assert_eq!(rows[0].1, 8080);
        assert_eq!(rows[0].2, "C:\\models\\test.gguf");
    }

    #[test]
    fn takes_last_port_and_model() {
        // spawn_server appends --host/--port at the end; a quoted model path may hold spaces.
        let cmd = r#"C:\a\b.exe --port 5001 -m C:\x\one.gguf --host 127.0.0.1 --port 8080 -m "C:\y z\two gguf\model file.gguf""#;
        assert_eq!(parse_port(cmd), Some(8080));
        assert_eq!(parse_model(cmd).as_deref(), Some("C:\\y z\\two gguf\\model file.gguf"));
    }

    #[cfg(not(windows))]
    #[test]
    fn parses_mac_ps_line_with_spaces_in_paths() {
        // Captured from macOS ps (2026-09-14) — argv is printed verbatim, no re-quoting, so the
        // engine and model paths keep their embedded "Application Support" / space segments.
        let line = "62236 /Users/d/Library/Application Support/com.chachaanteng/engines/b10952-metal/llama-server -c 65536 --port 8080 -m /Users/d/Library/Application Support/models/gemma gguf/model file.gguf --host 127.0.0.1 --port 8080";
        let (pid, port, model) = parse_ps_line(line).expect("default install path must be recognized");
        assert_eq!(pid, 62236);
        assert_eq!(port, 8080);
        assert_eq!(model, "/Users/d/Library/Application Support/models/gemma gguf/model file.gguf");
    }

    #[test]
    fn model_value_stops_at_next_flag() {
        // Unquoted value with spaces runs until the next flag token; a later -m still wins.
        let cmd = "llama-server -m /a/b one.gguf --temp 0.8 -m \"/c/d two.gguf\"";
        assert_eq!(parse_model(cmd).as_deref(), Some("/c/d two.gguf"));
    }
}

/// Re-adopt llama-server processes that outlived the previous app session. The in-memory
/// registry is wiped on every restart but child servers survive a forced kill — without this
/// they become invisible orphans (no Monitor panels, no Quick Launch tab, unstopable from the UI).
/// Live output can't be recovered (the stdout pipe died with the old process), so entries are
/// flagged `reconnected` and a janitor drops them once /health stops answering.
pub async fn adopt_orphan_servers(
    app: AppHandle,
    servers: Arc<tokio::sync::Mutex<HashMap<u16, ServerEntry>>>,
) {
    let procs = tokio::task::spawn_blocking(|| enumerate_llama_server_processes())
        .await
        .unwrap_or_default();

    for (pid, port, model_path) in procs {
        let mut guard = servers.lock().await;
        if !guard.contains_key(&port) {
            guard.insert(
                port,
                ServerEntry {
                    pid,
                    model_path,
                    args_preview: String::new(),
                    logs: Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAP))),
                    reconnected: true,
                },
            );
        }
    }

    // Reconnected entries have no waiter task, so poll /health and drop the dead ones. A server
    // still loading its model has no bound port yet — require consecutive failures (≈2 min)
    // before dropping it so a slow load isn't lost.
    tokio::spawn(async move {
        let client = &crate::util::PROBE_CLIENT;
        let mut fails: std::collections::HashMap<u16, u32> = std::collections::HashMap::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let candidates: Vec<u16> = servers
                .lock()
                .await
                .iter()
                .filter(|(_, e)| e.reconnected)
                .map(|(port, _)| *port)
                .collect();
            for port in candidates {
                if health_ok(&client, port).await {
                    fails.remove(&port);
                    continue;
                }
                let n = fails.entry(port).or_insert(0);
                *n += 1;
                if *n < 12 {
                    continue; // still loading (or transient) — keep it a while longer
                }
                fails.remove(&port);
                let removed = servers.lock().await.remove(&port);
                if removed.is_some() {
                    let _ = app.emit(
                        "server-exited",
                        serde_json::json!({ "port": port, "code": null }),
                    );
                }
            }
        }
    });
}

#[tauri::command]
pub async fn server_health(port: u16, host: Option<String>) -> Result<bool, String> {
    let host = host.filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let client = &crate::util::PROBE_CLIENT;
    match client.get(format!("http://{host}:{port}/health")).send().await {
        Ok(r) if r.status().is_success() => Ok(true),
        _ => Ok(false),
    }
}

#[derive(Serialize, Clone)]
pub struct ServerLogFile {
    pub name: String,
    pub size_bytes: u64,
    pub modified_ms: i64,
}

/// List persisted server log files (newest first).
#[tauri::command]
pub async fn list_server_logs(app: AppHandle) -> Result<Vec<ServerLogFile>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = log_dir(&app)?;
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("log") {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let modified_ms = crate::util::file_mtime_ms(&meta);
            out.push(ServerLogFile {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                size_bytes: meta.len(),
                modified_ms,
            });
        }
        out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        out.truncate(100);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete server logs older than `days` (0 = keep everything). Returns the count removed.
pub fn prune_server_logs(app: &AppHandle, days: u32) -> Result<usize, String> {
    if days == 0 {
        return Ok(0);
    }
    let dir = log_dir(app)?;
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(u64::from(days) * 86_400);
    let mut removed = 0;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let stale = meta.modified().map(|t| t < cutoff).unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// True when `name` is a bare filename (no path separators, no "..") — blocks traversal.
fn is_safe_log_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

/// Read a persisted server log file (tail-capped so huge sessions stay cheap).
#[tauri::command]
pub async fn read_server_log(app: AppHandle, name: String) -> Result<String, String> {
    if !is_safe_log_name(&name) {
        return Err("invalid log file name".into());
    }
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let dir = log_dir(&app)?;
        const MAX_BYTES: usize = 256 * 1024;
        // Read only what we display — verbose sessions can produce multi-GB logs and a full
        // std::fs::read would spike RSS by the entire file size for a 256 KB tail.
        let mut f = std::fs::File::open(dir.join(name)).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len() as usize;
        if len <= MAX_BYTES {
            let mut data = Vec::new();
            f.read_to_end(&mut data).map_err(|e| e.to_string())?;
            return Ok(String::from_utf8_lossy(&data).into_owned());
        }
        // keep the tail (most recent lines), starting at a line boundary
        f.seek(SeekFrom::End(-((MAX_BYTES + 1) as i64))).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; MAX_BYTES + 1];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let start = buf.iter().position(|&b| b == b'\n').unwrap_or(buf.len());
        Ok(format!(
            "[truncated — showing last {} KB]\n{}",
            MAX_BYTES / 1024,
            String::from_utf8_lossy(&buf[start..])
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a persisted server log file (filename only — blocks path traversal).
#[tauri::command]
pub async fn delete_server_log(app: AppHandle, name: String) -> Result<(), String> {
    if !is_safe_log_name(&name) {
        return Err("invalid log file name".into());
    }
    tokio::task::spawn_blocking(move || {
        let dir = log_dir(&app)?;
        std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
