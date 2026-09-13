//! Small shared helpers used across several modules.

/// Windows GUI apps have no console of their own, so without CREATE_NO_WINDOW every spawned
/// console child (llama-server, nvidia-smi, taskkill…) gets its own visible window in release
/// builds — dev mode hides it because children inherit the dev terminal's console.
#[cfg(windows)]
pub fn hide_console_tokio(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(windows)]
pub fn hide_console_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

/// Push a line into a capped ring buffer, dropping the oldest lines past `cap`.
pub fn push_capped(q: &std::sync::Mutex<std::collections::VecDeque<String>>, line: String, cap: usize) {
    if let Ok(mut q) = q.lock() {
        q.push_back(line);
        while q.len() > cap {
            q.pop_front();
        }
    }
}

/// Unix epoch milliseconds (0 if the clock is before 1970).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lowercase hex encoding (e.g. SHA-256 digests).
pub fn hex_of(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// File mtime in Unix epoch milliseconds (0 if unavailable).
pub fn file_mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Declared body size from the Content-Length header (None if absent or unparseable).
pub fn declared_content_length(resp: &reqwest::Response) -> Option<u64> {
    resp.headers().get("content-length")?.to_str().ok()?.parse().ok()
}

/// Shared client for short API calls — a total timeout is right here (fail if the whole call drags).
pub fn http_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())
}

/// Shared client for streaming downloads — connect + read(stall) timeouts only. A total
/// `.timeout()` would cap the whole transfer and kill long downloads mid-stream.
pub fn http_client_streaming(read_stall: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(read_stall)
        .build()
        .map_err(|e| e.to_string())
}
