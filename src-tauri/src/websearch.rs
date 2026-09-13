//! Web search (FR2.4): SearXNG JSON when configured, DuckDuckGo HTML fallback.
//! Mirrors the reference backend/services/web_search.py semantics:
//! prefer SearXNG, fall back to DDG; results are {title, url, snippet}.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Static regexes — compiled once, not per search.
static DDG_RESULT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<a\b[^>]*class="result__a"[^>]*>(.*?)</a>"#).unwrap());
static DDG_HREF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"href="([^"]*)""#).unwrap());
static DDG_SNIPPET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<a\b[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).unwrap());

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub ok: bool,
    pub query: String,
    pub results: Vec<SearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn fail(query: &str, error: impl Into<String>) -> SearchResponse {
    SearchResponse { ok: false, query: query.to_string(), results: Vec::new(), error: Some(error.into()) }
}

/// Run a web search. SearXNG (if `searxng_url` is set) is tried first; on any
/// failure or empty result set we fall back to DuckDuckGo's HTML endpoint.
#[tauri::command]
pub async fn web_search(
    state: tauri::State<'_, crate::AppState>,
    query: String,
    max_results: Option<u32>,
) -> Result<SearchResponse, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(fail(&query, "No query provided."));
    }
    let max = (max_results.unwrap_or(5)).clamp(1, 10) as usize;

    // SearXNG first when configured (lock scoped so the guard never crosses an await)
    let settings_json = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_setting("settings").map_err(|e| format!("Failed to read settings: {e}"))?
    };
    if let Some(settings_json) = settings_json {
        if let Ok(settings) = serde_json::from_str::<crate::db::Settings>(&settings_json) {
            if let Some(base) = settings.searxng_url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                match searxng_search(&query, max, base).await {
                    Ok(r) if r.ok && !r.results.is_empty() => return Ok(r),
                    _ => {} // fall through to DDG
                }
            }
        }
    }

    ddg_search(&query, max).await
}

/// Open a URL in the default browser (http/https only).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("只可以打開 http/https 連結".into());
    }
    webbrowser::open(url).map_err(|e| format!("無法打開瀏覽器: {e}"))
}

// --- SearXNG -----------------------------------------------------------------

async fn searxng_search(query: &str, max: usize, base: &str) -> Result<SearchResponse, String> {
    let base = base.trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Ok(fail(query, "SearXNG endpoint not configured."));
    }
    let client = crate::util::http_client(Duration::from_secs(15))?;
    let v: serde_json::Value = client
        .get(format!("{base}/search"))
        .query(&[("q", query), ("format", "json")])
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let rows = v
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or("SearXNG response had no results list")?;
    let mut results = Vec::new();
    for row in rows {
        if !row.is_object() {
            continue;
        }
        let u = row.get("url").and_then(|x| x.as_str()).unwrap_or("");
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            continue;
        }
        results.push(SearchResult {
            title: row.get("title").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).unwrap_or(u).to_string(),
            url: u.to_string(),
            snippet: row
                .get("content")
                .and_then(|c| c.as_str())
                .filter(|c| !c.is_empty())
                .or_else(|| row.get("snippet").and_then(|s| s.as_str()))
                .unwrap_or("")
                .to_string(),
        });
        if results.len() >= max {
            break;
        }
    }
    Ok(SearchResponse { ok: true, query: query.to_string(), results, error: None })
}

// --- DuckDuckGo HTML -----------------------------------------------------------

async fn ddg_search(query: &str, max: usize) -> Result<SearchResponse, String> {
    let client = crate::util::http_client(Duration::from_secs(15))?;
    let html: String = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query)])
        .header("Accept", "text/html,application/xhtml+xml")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let snippets: Vec<String> = DDG_SNIPPET_RE
        .find_iter(&html)
        .map(|m| clean_html(m.as_str()))
        .collect();

    let mut results = Vec::new();
    for (i, m) in DDG_RESULT_RE.find_iter(&html).enumerate() {
        let tag_and_body = m.as_str();
        // href lives inside the opening <a ...> tag — the regex guarantees a '>' exists, so this
        // can't fail in practice; skip defensively rather than aborting the whole search.
        let Some(open_end) = tag_and_body.find('>') else { continue };
        let open_tag = &tag_and_body[..open_end];
        let href = DDG_HREF_RE
            .captures(open_tag)
            .and_then(|c| c.get(1))
            .map(|h| h.as_str().to_string())
            .unwrap_or_default();
        let final_url = resolve_ddg_link(&href);
        if !(final_url.starts_with("http://") || final_url.starts_with("https://")) {
            continue;
        }
        results.push(SearchResult {
            title: clean_html(&tag_and_body[open_end + 1..]),
            url: final_url,
            snippet: snippets.get(i).cloned().unwrap_or_default(),
        });
        if results.len() >= max {
            break;
        }
    }

    if results.is_empty() {
        return Ok(fail(query, "Search returned no results (DDG may be rate-limiting — try again or configure SearXNG)."));
    }
    Ok(SearchResponse { ok: true, query: query.to_string(), results, error: None })
}

/// DDG sometimes wraps result links in a redirect (`//duckduckgo.com/l/?uddg=<encoded>`);
/// unwrap it to the real URL.
fn resolve_ddg_link(href: &str) -> String {
    let href = if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        href.to_string()
    };
    if let Some(pos) = href.find("uddg=") {
        let start = pos + "uddg=".len();
        let rest = &href[start..];
        let end = rest.find('&').unwrap_or(rest.len());
        return percent_decode(&rest[..end]);
    }
    href
}

// --- small helpers -----------------------------------------------------------------

fn clean_html(s: &str) -> String {
    let no_tags: String = s.chars().filter(|c| *c != '<' && *c != '>').collect();
    unescape_entities(&no_tags)
        .replace('\u{a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn unescape_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find(';') {
        // only treat as entity if it starts with '&' and is short
        let before = &rest[..=pos];
        if let Some(amp) = before.rfind('&') {
            let ent = &before[amp..];
            if ent.len() <= 12 {
                out.push_str(&rest[..amp]);
                match unescape_one(ent) {
                    Some(ch) => out.push_str(&ch),
                    None => out.push_str(ent),
                }
                rest = &rest[pos + 1..];
                continue;
            }
        }
        out.push_str(before);
        rest = &rest[pos + 1..];
    }
    out.push_str(rest);
    out
}

fn unescape_one(ent: &str) -> Option<String> {
    let body = ent.strip_prefix('&')?.strip_suffix(';')?;
    if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
        return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).map(|c| c.to_string());
    }
    if let Some(dec) = body.strip_prefix('#') {
        return dec.parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string());
    }
    match body {
        "amp" => Some("&".into()),
        "lt" => Some("<".into()),
        "gt" => Some(">".into()),
        "quot" => Some("\"".into()),
        "apos" => Some("'".into()),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
