//! Hugging Face model discovery & download (FR4). Ported from the reference
//! hf_download.py: repo file listing via the HF API, streaming download to a
//! `.part` temp file with Content-Length verification, cancel support and
//! partial-file cleanup.

use crate::db::{Db, Settings};
use crate::AppState;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const HF_API: &str = "https://huggingface.co/api";
const HF_BASE: &str = "https://huggingface.co";
/// Emit progress events at most this often (UI stays smooth without flooding IPC).
const PROGRESS_INTERVAL_MS: u64 = 250;

// Static regexes — compiled once, not per call.
static REPO_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$").unwrap());
static UNSAFE_FILENAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"[<>:"/\\|?*]"##).unwrap());
static SHARD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.+)-(\d{5})-of-(\d{5})(\.gguf)$").unwrap());

// ---------------------------------------------------------------------------
// validation (ported from reference)
// ---------------------------------------------------------------------------

pub fn validate_hf_repo_id(repo_id: &str) -> Result<String, String> {
    let v = repo_id.trim();
    if !REPO_ID_RE.is_match(v) {
        return Err("Enter a Hugging Face repo ID like owner/model.".into());
    }
    if v.contains("..") || v.ends_with('.') {
        return Err("Invalid Hugging Face repo ID.".into());
    }
    Ok(v.to_string())
}

pub fn validate_hf_revision(revision: &str) -> Result<String, String> {
    let v = revision.trim();
    let v = if v.is_empty() { "main" } else { v };
    if v.starts_with('/') || v.contains('\\') || v.contains('\0') || v.split('/').any(|p| p == "..") {
        return Err("Invalid Hugging Face revision.".into());
    }
    Ok(v.to_string())
}

fn is_windows_device_name(stem: &str) -> bool {
    (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit()
        && stem.as_bytes()[3] != b'0'
}

pub fn validate_hf_filename(filename: &str) -> Result<String, String> {
    let v = filename.trim().replace('\\', "/");
    if v.is_empty() || v.starts_with('/') || v.contains('\0') {
        return Err("Invalid Hugging Face filename.".into());
    }
    let parts: Vec<&str> = v.split('/').collect();
    if parts.iter().any(|p| *p == "..") {
        return Err("Invalid Hugging Face filename.".into());
    }
    let name = *parts.last().unwrap_or(&"");
    if name.is_empty() || UNSAFE_FILENAME_RE.is_match(name) {
        return Err("Hugging Face filename is not safe to save locally.".into());
    }    if !name.to_lowercase().ends_with(".gguf") {
        return Err("Only .gguf files can be downloaded.".into());
    }
    let device = name.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str()) || is_windows_device_name(&device) {
        return Err("Invalid Hugging Face filename.".into());
    }
    Ok(v.to_string())
}

pub fn is_mmproj_filename(filename: &str) -> bool {
    let name = filename.replace('\\', "/");
    let base = name.rsplit('/').next().unwrap_or(&name).to_lowercase();
    let stem = base.split('.').next().unwrap_or(&base);
    stem.contains("mmproj") || stem.starts_with("clip") || stem.contains("projector")
}

/// Complete split set for a sharded GGUF, starting with shard 1.
pub fn model_shard_files(filename: &str) -> Result<Vec<String>, String> {
    let lower = filename.to_lowercase();
    // The spans below come from `lower` but are applied to `filename` — only safe when
    // lowercasing didn't change byte length (it can, e.g. 'İ'). Otherwise: single file.
    if lower.len() != filename.len() {
        return Ok(vec![filename.to_string()]);
    }
    let caps = match SHARD_RE.captures(lower.as_str()) {
        Some(c) => c,
        None => return Ok(vec![filename.to_string()]),
    };
    let index: u32 = caps.get(2).unwrap().as_str().parse().map_err(|_| String::from("bad shard"))?;
    let count: u32 = caps.get(3).unwrap().as_str().parse().map_err(|_| String::from("bad shard"))?;
    if !(1..=count).contains(&index) || count > 65535 {
        return Err("Invalid split GGUF shard number or count.".into());
    }
    // keep the original casing from the real filename (prefix + suffix spans)
    let prefix = &filename[..caps.get(1).unwrap().end()];
    let suffix = &filename[caps.get(4).unwrap().start()..];
    Ok((1..=count)
        .map(|part| format!("{prefix}-{part:05}-of-{count}{suffix}"))
        .collect())
}

// ---------------------------------------------------------------------------
// repo file listing
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct HfFile {
    pub name: String,
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shard_count: Option<usize>,
}

#[derive(Serialize)]
pub struct HfRepoFiles {
    pub repo_id: String,
    pub revision: String,
    pub models: Vec<HfFile>,
    pub mmproj: Vec<HfFile>,
}

fn to_hf_file(name: &str, size: Option<u64>) -> HfFile {
    HfFile { name: name.to_string(), size, shard_count: None }
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    lfs: Option<LfsInfo>,
}

#[derive(Deserialize)]
struct LfsInfo {
    #[serde(default)]
    size: Option<u64>,
}

async fn fetch_tree(client: &reqwest::Client, repo: &str, rev: &str) -> Result<Vec<TreeEntry>, String> {
    let url = format!("{HF_API}/models/{repo}/tree/{rev}?recursive=true");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Hugging Face lookup failed (HTTP {})", resp.status()));
    }
    resp.json::<Vec<TreeEntry>>().await.map_err(|e| format!("HF API parse error: {e}"))
}

/// A repo's actual default branch — many older repos use "master", not "main".
async fn fetch_default_branch(client: &reqwest::Client, repo: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct RepoInfo {
        #[serde(default, rename = "defaultBranch")]
        default_branch: Option<String>,
    }
    let url = format!("{HF_API}/models/{repo}");
    client.get(&url).send().await.ok()?.json::<RepoInfo>().await.ok()?.default_branch
}

/// List the tree; if the (default) revision doesn't exist, retry once on the repo's real default branch.
/// Returns the entries plus the revision that actually worked.
async fn fetch_tree_resolved(
    client: &reqwest::Client,
    repo: &str,
    rev: &str,
) -> Result<(Vec<TreeEntry>, String), String> {
    match fetch_tree(client, repo, rev).await {
        Ok(entries) => Ok((entries, rev.to_string())),
        Err(err) if (err.contains("HTTP 401") || err.contains("HTTP 404")) && rev == "main" => {
            match fetch_default_branch(client, repo).await {
                Some(db) if !db.is_empty() && db != "main" => {
                    fetch_tree(client, repo, &db).await.map(|entries| (entries, db)).map_err(|_| err)
                }
                _ => Err(err),
            }
        }
        Err(e) => Err(e),
    }
}

/// List .gguf files in a repo, grouped into launchable models (shards merged) + mmproj companions.
#[tauri::command]
pub async fn hf_list_repo_files(repo_id: String, revision: String) -> Result<HfRepoFiles, String> {
    let repo = validate_hf_repo_id(&repo_id)?;
    let rev = validate_hf_revision(&revision)?;

    let client = crate::util::http_client(std::time::Duration::from_secs(30))?;
    let (entries, rev) = fetch_tree_resolved(&client, &repo, &rev).await?;

    let mut files: Vec<HfFile> = Vec::new();
    for e in &entries {
        if !e.path.to_lowercase().ends_with(".gguf") {
            continue;
        }
        let size = e.lfs.as_ref().and_then(|l| l.size).or(e.size);
        files.push(to_hf_file(&e.path, size));
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let by_name: std::collections::HashMap<&str, &HfFile> =
        files.iter().map(|f| (f.name.as_str(), f)).collect();
    let mut main_files: Vec<HfFile> = Vec::new();
    let mut grouped: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in &files {
        if grouped.contains(item.name.as_str()) || is_mmproj_filename(&item.name) {
            continue;
        }
        let shards = model_shard_files(&item.name)?;
        for s in &shards {
            grouped.insert(s.clone());
        }
        // only launchable when this entry is shard 1 and every shard exists
        if item.name != shards[0] || !shards.iter().all(|s| by_name.contains_key(s.as_str())) {
            continue;
        }
        if shards.len() > 1 {
            let sizes: Vec<Option<u64>> = shards.iter().map(|s| by_name.get(s.as_str()).unwrap().size).collect();
            let total = sizes.iter().all(|s| s.is_some()).then(|| sizes.iter().map(|s| s.unwrap()).sum::<u64>());
            let mut merged = item.clone();
            merged.shard_count = Some(shards.len());
            merged.size = total;
            main_files.push(merged);
        } else {
            main_files.push(item.clone());
        }
    }
    let mmproj: Vec<HfFile> = files.into_iter().filter(|f| is_mmproj_filename(&f.name)).collect();

    Ok(HfRepoFiles { repo_id: repo, revision: rev, models: main_files, mmproj })
}

// ---------------------------------------------------------------------------
// model search (FR4.2) — type "nvidia" → matching repos, click to fill the ID
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct HfModelHit {
    pub id: String,
    pub downloads: u64,
}

#[derive(Deserialize)]
struct HfSearchResult {
    #[serde(default)]
    id: String,
    #[serde(default)]
    downloads: Option<u64>,
}

/// Search the HF model hub. `gguf_only` restricts to repos tagged "gguf".
#[tauri::command]
pub async fn hf_search_models(query: String, gguf_only: bool) -> Result<Vec<HfModelHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let client = crate::util::http_client(std::time::Duration::from_secs(30))?;

    let mut params: Vec<(&str, String)> = vec![
        ("search".into(), q.into()),
        ("limit".into(), "50".into()),
        ("sort".into(), "downloads".into()),
        ("direction".into(), "-1".into()),
    ];
    if gguf_only {
        params.push(("filter".into(), "gguf".into()));
    }

    let resp = client
        .get(format!("{HF_API}/models"))
        .query(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Hugging Face search failed (HTTP {})", resp.status()));
    }
    let results: Vec<HfSearchResult> =
        resp.json().await.map_err(|e| format!("HF API parse error: {e}"))?;

    Ok(results
        .into_iter()
        .filter(|r| !r.id.is_empty())
        .map(|r| HfModelHit { id: r.id, downloads: r.downloads.unwrap_or(0) })
        .collect())
}

// ---------------------------------------------------------------------------
// single-repo info — post-download metadata enrichment
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GgufBlock {
    /// GGUF architecture string, e.g. "nemotron_h" / "llama" / "qwen2".
    #[serde(default)]
    architecture: Option<String>,
}

#[derive(Deserialize)]
struct ModelInfoRaw {
    #[serde(default)]
    id: String,
    #[serde(default)]
    author: String,
    /// Present only for repos where HF parsed a GGUF header.
    #[serde(default)]
    gguf: Option<GgufBlock>,
}

#[derive(Serialize, Clone)]
pub struct HfModelInfo {
    pub id: String,
    pub author: String,
    /// GGUF architecture string (e.g. "nemotron_h") — None for repos without parsed GGUF metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gguf_architecture: Option<String>,
}

/// Fetch a single repo's info — `GET /api/models/{repo}` (the same endpoint fetch_default_branch uses).
#[tauri::command]
pub async fn hf_model_info(repo_id: String) -> Result<HfModelInfo, String> {
    let repo = validate_hf_repo_id(&repo_id)?;
    let client = crate::util::http_client(std::time::Duration::from_secs(30))?;
    let resp = client
        .get(format!("{HF_API}/models/{repo}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Hugging Face lookup failed (HTTP {})", resp.status()));
    }
    let raw: ModelInfoRaw = resp.json().await.map_err(|e| format!("HF API parse error: {e}"))?;
    Ok(HfModelInfo {
        id: raw.id,
        author: raw.author,
        gguf_architecture: raw.gguf.and_then(|g| g.architecture),
    })
}

// ---------------------------------------------------------------------------
// download state machine
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct HfDownloadState {
    pub status: String, // idle | starting | downloading | cancelling | done | error | cancelled
    pub message: String,
    /// Original repo id (e.g. "unsloth/Qwen3.5-2B-GGUF") — set at start so the done event can enrich metadata from it.
    pub repo_id: String,
    pub total: u64,
    pub downloaded: u64,
    pub current_file: String,
    pub model_path: String,
}

impl Default for HfDownloadState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            message: "".into(),
            repo_id: "".into(),
            total: 0,
            downloaded: 0,
            current_file: "".into(),
            model_path: "".into(),
        }
    }
}

#[derive(Default)]
struct HfStateUpdate {
    status: Option<String>,
    message: Option<String>,
    repo_id: Option<String>,
    total: Option<u64>,
    downloaded: Option<u64>,
    current_file: Option<String>,
    model_path: Option<String>,
}

macro_rules! apply_updates {
    ($guard:expr, $updates:expr, $($field:ident),*) => {
        $(if let Some(v) = $updates.$field {
            $guard.$field = v;
        })*
    };
}

async fn update_state(
    state: &tokio::sync::Mutex<HfDownloadState>,
    app: &AppHandle,
    updates: HfStateUpdate,
) {
    let mut guard = state.lock().await;
    apply_updates!(guard, updates, status, message, repo_id, total, downloaded, current_file, model_path);
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("hf-download-progress", &snapshot);
}

/// Active model root: settings.models_dir (must exist) or the app-managed default.
pub fn get_models_dir(app: &AppHandle, db: &Db) -> Result<PathBuf, String> {
    let configured = db
        .get_setting("settings")
        .map_err(|e| format!("Failed to read settings: {e}"))?
        .and_then(|json| serde_json::from_str::<Settings>(&json).ok())
        .and_then(|s| s.models_dir.clone());

    match configured {
        Some(ref p) if !p.trim().is_empty() => {
            let path = PathBuf::from(p);
            if !path.is_absolute() {
                return Err("Configured models folder must be an absolute path.".into());
            }
            if !path.is_dir() {
                return Err(format!("Models folder does not exist: {p}"));
            }
            Ok(path)
        }
        _ => {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
            std::fs::create_dir_all(&dir).map_err(|e| format!("Models folder unavailable: {e}"))?;
            Ok(dir)
        }
    }
}

fn slugify_repo_id(repo_id: &str) -> String {
    let s: String = repo_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let t = s.trim_matches(|c| c == '.' || c == '_' || c == '-').to_string();
    if t.is_empty() { "repo".into() } else { t }
}

fn part_path(dest: &std::path::Path) -> PathBuf {
    dest.with_extension(format!(
        "{}.part",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("")
    ))
}

fn remove_partial(paths: &[PathBuf]) {
    for p in paths {
        let _ = std::fs::remove_file(part_path(p));
    }
}

/// Stream one file to `dest.part`, verify size against Content-Length, atomically rename.
async fn download_one(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    cancel: &CancellationToken,
    state: &tokio::sync::Mutex<HfDownloadState>,
    app: &AppHandle,
    base_downloaded: u64,
    total: u64,
) -> Result<u64, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from Hugging Face", resp.status()));
    }
    // declared body size — a dropped connection looks like clean EOF, so we must verify
    let expected = crate::util::declared_content_length(&resp);

    let part = part_path(dest);
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;

    let display_name = dest.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            return Err("__cancelled__".into());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= PROGRESS_INTERVAL_MS as u128 {
            last_emit = std::time::Instant::now();
            update_state(
                state,
                app,
                HfStateUpdate {
                    downloaded: Some(base_downloaded + downloaded),
                    total: Some(total),
                    current_file: Some(display_name.clone()),
                    ..Default::default()
                },
            )
            .await;
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;

    if let Some(exp) = expected {
        if downloaded != exp {
            return Err(format!(
                "Download of {display_name} was incomplete: got {downloaded} bytes, expected {exp}."
            ));
        }
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| e.to_string())?;
    Ok(downloaded)
}

#[tauri::command]
pub async fn hf_start_download(
    app: AppHandle,
    repo_id: String,
    revision: String,
    model_file: String,
    mmproj_file: Option<String>,
    overwrite: bool,
) -> Result<HfDownloadState, String> {
    // One state reference for the whole command — no State<'_> param + re-fetch dance.
    let state = &*app.state::<AppState>();
    let repo = validate_hf_repo_id(&repo_id)?;
    let rev = validate_hf_revision(&revision)?;
    let model = validate_hf_filename(&model_file)?;
    let mmproj = match mmproj_file.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(f) => Some(validate_hf_filename(f)?),
        None => None,
    };

    if is_mmproj_filename(&model) {
        return Err("Choose a main model file, not an mmproj file.".into());
    }
    if let Some(ref m) = mmproj {
        if !is_mmproj_filename(m) {
            return Err("Choose an mmproj/projector file for the companion mmproj download.".into());
        }
    }

    // Fast-fail if a download is already in progress; the real claim happens atomically
    // right before spawning (below), which closes the race between two rapid start calls.
    {
        let guard = state.hf_download.lock().await;
        if matches!(guard.status.as_str(), "starting" | "downloading" | "cancelling") {
            return Err("A model download is already in progress.".into());
        }
    }

    // resolve destinations before spawning so errors surface synchronously
    let models_dir = get_models_dir(&app, &state.db.lock().unwrap_or_else(|p| p.into_inner()))?;

    let repo_folder = slugify_repo_id(&repo);
    let model_basename = model.rsplit('/').next().unwrap_or(&model).to_string();
    let model_name = format!("{repo_folder}/{model_basename}"); // relative id under the root
    let model_dest = models_dir.join(&repo_folder).join(&model_basename);

    // (api path, dest) pairs — api path keeps subfolders, dest is flat per repo folder
    let mut downloads: Vec<(String, PathBuf)> = model_shard_files(&model)?
        .iter()
        .map(|s| {
            (
                s.clone(),
                models_dir.join(&repo_folder).join(s.rsplit('/').next().unwrap_or(s)),
            )
        })
        .collect();
    let mmproj_dest: Option<PathBuf> = mmproj.as_ref().map(|m| {
        model_dest.parent().unwrap_or(&models_dir).join(m.rsplit('/').next().unwrap_or(m))
    });
    if let (Some(ref m), Some(ref d)) = (&mmproj, &mmproj_dest) {
        downloads.push((m.clone(), d.clone()));
    }

    // existence check → "Already exists:" error the UI turns into a replace prompt
    let existing: Vec<String> = downloads
        .iter()
        .filter(|(_, dest)| dest.exists())
        .map(|(_, dest)| dest.file_name().unwrap_or_default().to_string_lossy().into_owned())
        .collect();
    if !existing.is_empty() && !overwrite {
        return Err(format!("Already exists: {}", existing.join(", ")));
    }

    // connect + read(stall) timeouts only — a client-level `.timeout()` caps the TOTAL request
    // time, which would kill any multi-GB download mid-stream.
    let client = crate::util::http_client_streaming(std::time::Duration::from_secs(120))?;

    // Claim the slot atomically (check + set under one lock) just before spawning — every
    // fallible step above has already run, so a claimed slot always leads to a spawn.
    {
        let mut guard = state.hf_download.lock().await;
        if matches!(guard.status.as_str(), "starting" | "downloading" | "cancelling") {
            return Err("A model download is already in progress.".into());
        }
        guard.status = "starting".into();
        guard.repo_id = repo.clone();
    }
    let cancel = CancellationToken::new();
    *state.hf_cancel.lock().await = Some(cancel.clone());

    let app_c = app.clone();
    let hf_state = state.hf_download.clone();
    let repo_ret = repo.clone(); // the spawn below moves `repo`
    tokio::spawn(async move {
        run_hf_download(client, repo, rev, downloads, model_name, model_dest, cancel, hf_state, app_c).await;
    });

    Ok(HfDownloadState {
        status: "starting".into(),
        message: "Preparing Hugging Face download...".into(),
        repo_id: repo_ret,
        ..Default::default()
    })
}

async fn run_hf_download(
    client: reqwest::Client,
    repo: String,
    rev: String,
    downloads: Vec<(String, PathBuf)>,
    model_name: String,
    model_dest: PathBuf,
    cancel: CancellationToken,
    hf_state: Arc<tokio::sync::Mutex<HfDownloadState>>,
    app: AppHandle,
) {
    let destinations: Vec<PathBuf> = downloads.iter().map(|(_, d)| d.clone()).collect();

    // best-effort total from the tree API (0 = unknown → indeterminate bar)
    let total: u64 = fetch_tree(&client, &repo, &rev)
        .await
        .ok()
        .map(|entries| {
            entries.iter().filter_map(|e| {
                downloads
                    .iter()
                    .find(|(p, _)| p == &e.path)
                    .map(|_| e.lfs.as_ref().and_then(|l| l.size).or(e.size).unwrap_or(0))
            }).sum::<u64>()
        })
        .unwrap_or(0);

    let result: Result<(), String> = async {
        tokio::fs::create_dir_all(model_dest.parent().unwrap_or(std::path::Path::new(".")))
            .await
            .map_err(|e| e.to_string())?;

        update_state(
            &hf_state,
            &app,
            HfStateUpdate {
                status: Some("downloading".into()),
                message: Some(format!("Downloading {model_name}...")),
                total: Some(total),
                downloaded: Some(0),
                ..Default::default()
            },
        )
        .await;

        let mut completed: u64 = 0;
        for (filename, dest) in &downloads {
            if cancel.is_cancelled() {
                return Err("__cancelled__".into());
            }
            update_state(
                &hf_state,
                &app,
                HfStateUpdate {
                    message: Some(format!("Downloading {}", dest.file_name().unwrap_or_default().to_string_lossy())),
                    ..Default::default()
                },
            )
            .await;
            let url = format!("{HF_BASE}/{repo}/resolve/{rev}/{filename}");
            completed += download_one(&client, &url, dest, &cancel, &hf_state, &app, completed, total).await?;
        }
        if cancel.is_cancelled() {
            return Err("__cancelled__".into());
        }
        Ok(())
    }
    .await;

    // One terminal state update for all three outcomes (done / cancelled / error).
    let done = result.is_ok();
    let status = if done { "done" } else if cancel.is_cancelled() { "cancelled" } else { "error" };
    let message = match &result {
        Ok(()) => format!("Downloaded {model_name}."),
        // in the Err arm `!done` is always true — only the cancel flag decides
        Err(e) if cancel.is_cancelled() => "Download cancelled.".into(),
        Err(e) => e.clone(),
    };
    update_state(
        &hf_state,
        &app,
        HfStateUpdate {
            status: Some(status.into()),
            message: Some(message),
            current_file: Some(String::new()),
            model_path: done.then(|| model_dest.to_string_lossy().into_owned()),
            ..Default::default()
        },
    )
    .await;

    // cleanup partials + release the slot
    remove_partial(&destinations);
}

#[tauri::command]
pub async fn hf_cancel_download(app: AppHandle, state: State<'_, AppState>) -> Result<HfDownloadState, String> {
    let snapshot = state.hf_download.lock().await.clone();
    if !matches!(snapshot.status.as_str(), "starting" | "downloading") {
        return Ok(snapshot);
    }
    if let Some(token) = state.hf_cancel.lock().await.as_ref() {
        token.cancel();
    }
    update_state(
        &state.hf_download,
        &app,
        HfStateUpdate { status: Some("cancelling".into()), message: Some("Cancelling download...".into()), ..Default::default() },
    )
    .await;
    Ok(snapshot)
}

#[tauri::command]
pub async fn hf_get_download_status(state: State<'_, AppState>) -> Result<HfDownloadState, String> {
    Ok(state.hf_download.lock().await.clone())
}

// ---------------------------------------------------------------------------
// local model listing (FR4.1)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ModelsDirInfo {
    pub models_dir: String,
}

#[tauri::command]
pub async fn get_models_dir_info(app: AppHandle, state: State<'_, AppState>) -> Result<ModelsDirInfo, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    // get_models_dir reads the settings row itself — no second read needed here.
    let dir = get_models_dir(&app, &db)?;
    Ok(ModelsDirInfo { models_dir: dir.to_string_lossy().into_owned() })
}

#[derive(Serialize)]
pub struct LocalModelFile {
    /// path relative to the models root (forward slashes)
    pub rel_path: String,
    pub size_bytes: u64,
}

/// Recursively list .gguf files under a directory (depth-capped, sorted).
#[tauri::command]
pub async fn list_local_models(root: Option<String>) -> Result<Vec<LocalModelFile>, String> {
    let root = match root {
        Some(r) if !r.trim().is_empty() => PathBuf::from(r),
        _ => return Err("No models folder configured".into()),
    };
    if !root.is_dir() {
        return Err(format!("Models folder does not exist: {}", root.display()));
    }

    // Recursive walk can be slow on big model trees — keep it off the async runtime.
    tokio::task::spawn_blocking(move || {
        let mut out: Vec<LocalModelFile> = Vec::new();
        walk_gguf(&root, &root, 0, &mut out).map_err(|e| e.to_string())?;
        out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// FR4.1 — delete a local GGUF file under the models root (traversal rejected).
#[tauri::command]
pub async fn delete_local_model(root: String, rel_path: String) -> Result<(), String> {
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err(format!("Models folder does not exist: {root}"));
    }
    let rel = PathBuf::from(rel_path.replace('\\', "/"));
    if rel.as_os_str().is_empty()
        || rel.is_absolute()
        || rel.components().any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Invalid model path".into());
    }
    let target = base.join(&rel);
    if !target.is_file() {
        return Err(format!("File not found: {}", rel.display()));
    }
    // Only ever delete GGUF files — never directories or other file types.
    if target.extension().and_then(|s| s.to_str()) != Some("gguf") {
        return Err("Only .gguf model files can be deleted".into());
    }
    std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    // Clean up any leftover partial download for the same file.
    let _ = std::fs::remove_file(part_path(&target));
    // Tidy: drop the containing folder if this was its last file (never the models root itself),
    // so deletions don't leave empty shells behind on disk.
    if let Some(parent) = target.parent() {
        if parent != base.as_path() && std::fs::read_dir(parent).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(())
}

/// Delete a GGUF file by absolute path (user-imported model cleanup).
#[tauri::command]
pub async fn delete_model_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("File not found: {path}"));
    }
    // Only ever delete GGUF files — never directories or other file types.
    if p.extension().and_then(|s| s.to_str()) != Some("gguf") {
        return Err("Only .gguf model files can be deleted".into());
    }
    std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(part_path(&p));
    Ok(())
}

fn walk_gguf(
    base: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    out: &mut Vec<LocalModelFile>,
) -> std::io::Result<()> {
    if depth > 6 {
        return Ok(()); // guard against pathological nesting
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_gguf(base, &path, depth + 1, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("gguf") {
            let meta = entry.metadata()?;
            let rel = path.strip_prefix(base).unwrap_or(&path);
            out.push(LocalModelFile {
                rel_path: rel.to_string_lossy().replace('\\', "/"),
                size_bytes: meta.len(),
            });
        }
    }
    Ok(())
}
