use base64::Engine as _;
use crate::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    /// Plain string for normal messages; an array of OpenAI content parts (text / image_url)
    /// when the message carries attachments. The server accepts both shapes.
    pub content: serde_json::Value,
}

#[derive(Deserialize, Clone)]
pub struct ChatParams {
    /// Sampling overrides — omitted = the server's launch-time settings apply.
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Per-request chat template override (llama.cpp accepts this in the body).
    #[serde(default)]
    pub chat_template: Option<String>,
    /// Per-request template kwargs, e.g. {"enable_thinking": false} for compaction.
    #[serde(default)]
    pub chat_template_kwargs: Option<serde_json::Value>,
    /// Thinking-model effort (b10864+): "low" | "medium" | "high". "none" disables thinking;
    /// any other value is passed through to the model's Jinja template as-is.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

/// One streamed token. `kind` is "content" or "reasoning" (models that emit
/// reasoning_content, e.g. Qwen3 / DeepSeek thinking mode).
#[derive(Serialize, Clone)]
pub struct StreamToken {
    pub kind: &'static str,
    pub text: String,
}

/// Attach the stored API key when this (host, port) is a registered external server.
async fn with_auth(mut req: reqwest::RequestBuilder, state: &AppState, host: &str, port: u16) -> reqwest::RequestBuilder {
    if let Some(auth) = crate::external::auth_header(state, host, port).await {
        req = req.header("Authorization", auth);
    }
    req
}

/// Proxy chat completion to the local llama-server and stream tokens back
/// through a Tauri Channel (avoids CORS / mixed-content issues in the webview).
#[tauri::command]
pub async fn chat_stream(
    state: State<'_, AppState>,
    port: u16,
    host: String,
    messages: Vec<ChatMessage>,
    params: ChatParams,
    on_token: Channel<StreamToken>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    *state.chat_cancel.lock().await = Some(token.clone());
    // Clear the slot on every exit path (success or error) so stop_chat never holds a stale token.
    let res = stream_chat(&state, port, host, messages, params, on_token, &token).await;
    *state.chat_cancel.lock().await = None;
    res
}

async fn stream_chat(
    state: &AppState,
    port: u16,
    host: String,
    messages: Vec<ChatMessage>,
    params: ChatParams,
    on_token: Channel<StreamToken>,
    token: &CancellationToken,
) -> Result<(), String> {
    // SSE stream — read(stall) timeout only, never a total one (a long generation is fine).
    let client = &crate::util::CHAT_STREAM_CLIENT;

    let mut body = serde_json::json!({
        "model": "local",
        "messages": messages,
        "stream": true,
    });
    // Sampling overrides are optional — when absent the server's launch-time settings apply.
    if let Some(v) = params.temperature {
        body["temperature"] = serde_json::Value::from(v);
    }
    if let Some(v) = params.top_p {
        body["top_p"] = serde_json::Value::from(v);
    }
    if let Some(v) = params.max_tokens {
        body["max_tokens"] = serde_json::Value::from(v);
    }
    if let Some(t) = &params.chat_template {
        body["chat_template"] = serde_json::Value::String(t.clone());
    }
    if let Some(kw) = &params.chat_template_kwargs {
        body["chat_template_kwargs"] = kw.clone();
    }
    if let Some(e) = &params.reasoning_effort {
        body["reasoning_effort"] = serde_json::Value::String(e.clone());
    }

    // FR8.3 — attach the stored key when this (host, port) is the registered external server
    let req = with_auth(client.post(format!("http://{host}:{port}/v1/chat/completions")).json(&body), &state, &host, port).await;
    let resp = req
        .send()
        .await
        .map_err(|e| format!("連唔到 server ({host}:{port}): {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("server 錯誤: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    'done: loop {
        tokio::select! {
            _ = token.cancelled() => break,
            item = stream.next() => match item {
                Some(Ok(bytes)) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // process complete SSE lines
                    while let Some(nl) = buf.find('\n') {
                        let line: String = buf.drain(..=nl).collect();
                        let line = line.trim();
                        if !line.starts_with("data:") {
                            continue;
                        }
                        let payload = line[5..].trim();
                        if payload == "[DONE]" {
                            break 'done;
                        }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                            let delta = v.pointer("/choices/0/delta");
                            if let Some(delta) = delta {
                                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                    if !content.is_empty() {
                                        on_token.send(StreamToken { kind: "content", text: content.to_string() }).ok();
                                    }
                                }
                                // reasoning_content (Qwen3 / DeepSeek thinking mode)
                                if let Some(reasoning) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
                                    if !reasoning.is_empty() {
                                        on_token.send(StreamToken { kind: "reasoning", text: reasoning.to_string() }).ok();
                                    }
                                }
                            }
                        }
                    }
                }
                Some(Err(e)) => return Err(format!("stream 中斷: {e}")),
                None => break,
            },
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_chat(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(token) = state.chat_cancel.lock().await.take() {
        token.cancel();
    }
    Ok(())
}

/// Live context capacity from the server's slots endpoint (min n_ctx across slots).
#[tauri::command]
pub async fn context_capacity(state: State<'_, AppState>, port: u16, host: String) -> Result<u32, String> {
    let client = &crate::util::PROBE_CLIENT;
    let req = with_auth(client.get(format!("http://{host}:{port}/slots")), &state, &host, port).await;
    let v: serde_json::Value = req
        .send()
        .await
        .map_err(|e| format!("連唔到 server ({host}:{port}): {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let slots = v
        .as_array()
        .ok_or("slots endpoint 返回格式錯誤")?;
    if slots.is_empty() {
        return Err("server 冇 slot".into());
    }
    let min_ctx = slots
        .iter()
        .filter_map(|s| s.get("n_ctx").and_then(|c| c.as_u64()))
        .min()
        .ok_or("slots 入面搵唔到 n_ctx")?;
    Ok(min_ctx as u32)
}

/// Exact prompt token count: the server renders the chat template itself, so this
/// matches what a real completion would consume. Costs one decode step (max_tokens=1).
#[tauri::command]
pub async fn measure_prompt_tokens(
    state: State<'_, AppState>,
    port: u16,
    host: String,
    messages: Vec<ChatMessage>,
) -> Result<u32, String> {
    // This is a REAL prefill of the whole history — on CPU-only machines it can take minutes,
    // so a total timeout would fail slow-but-healthy servers. Connect fails fast (30 s); only
    // five full minutes of silence counts as a stall (same bound chat_stream uses).
    let client = &crate::util::CHAT_STREAM_CLIENT;
    let body = serde_json::json!({
        "model": "local",
        "messages": messages,
        "stream": false,
        "max_tokens": 1,
        "temperature": 0.0,
    });
    let req = with_auth(client.post(format!("http://{host}:{port}/v1/chat/completions")).json(&body), &state, &host, port).await;
    let v: serde_json::Value = req
        .send()
        .await
        .map_err(|e| format!("連唔到 server ({host}:{port}): {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    v.pointer("/usage/prompt_tokens")
        .and_then(|t| t.as_u64())
        .map(|n| n as u32)
        .ok_or("server 冇返回 usage.prompt_tokens".into())
}

/// Fast approximate token count via the server's tokenizer (no template rendering —
/// undercounts by the per-message wrapper tokens; good enough for live estimates).
#[tauri::command]
pub async fn tokenize_count(state: State<'_, AppState>, port: u16, host: String, text: String) -> Result<u32, String> {
    let client = &crate::util::API_CLIENT;
    let req = with_auth(client.post(format!("http://{host}:{port}/tokenize")).json(&serde_json::json!({ "content": text })), &state, &host, port).await;
    let v: serde_json::Value = req
        .send()
        .await
        .map_err(|e| format!("連唔到 server ({host}:{port}): {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    v.pointer("/tokens")
        .and_then(|t| t.as_array())
        .map(|a| a.len() as u32)
        .ok_or("tokenize endpoint 返回格式錯誤".into())
}

/// A file attached to a chat message from the composer's attachment button.
#[derive(Serialize)]
pub struct AttachmentData {
    /// File name (with extension) — shown in the composer chip and the injected header.
    pub name: String,
    /// "image" → `data` is a base64 data URL; "text" → `data` is the file content.
    pub kind: &'static str,
    pub data: String,
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;

/// Read a user-picked file for chat attachment. Images become base64 data URLs (sent as
/// image_url parts — only mmproj vision models can actually use them); anything else is
/// returned verbatim when it's valid UTF-8 so the frontend appends it to the message.
#[tauri::command]
pub async fn read_attachment(path: String) -> Result<AttachmentData, String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("attachment").to_string();

    // Size-check via metadata BEFORE reading — an over-cap file is rejected without loading it.
    let len = tokio::fs::metadata(p).await.map_err(|e| format!("讀唔到檔案: {e}"))?.len();

    if IMAGE_EXTS.contains(&ext.as_str()) {
        if len > MAX_IMAGE_BYTES {
            return Err("圖片太大（上限 10MB）".into());
        }
        let bytes = tokio::fs::read(p).await.map_err(|e| format!("讀唔到檔案: {e}"))?;
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/bmp",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(AttachmentData { name, kind: "image", data: format!("data:{mime};base64,{b64}") });
    }

    if len > MAX_TEXT_BYTES {
        return Err("文字檔太大（上限 1MB）".into());
    }
    let bytes = tokio::fs::read(p).await.map_err(|e| format!("讀唔到檔案: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "二進制檔案，無法附加".to_string())?;
    Ok(AttachmentData { name, kind: "text", data: text })
}
