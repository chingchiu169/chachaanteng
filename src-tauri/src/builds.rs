use crate::hw::{detect, HardwareInfo};
use crate::util::hex_of;
use crate::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const REPO_API: &str = "https://api.github.com/repos/ggml-org/llama.cpp";

/// One installable backend: which archive(s) to fetch and where they land.
struct BackendSpec {
    key: &'static str,
    label: &'static str,
    /// asset name template; "{tag}" is replaced with the release tag (e.g. b7184)
    asset: &'static str,
    /// extra archives extracted into the same dir (CUDA needs cudart alongside)
    extra_assets: &'static [&'static str],
}

const WIN_X64_SPECS: &[BackendSpec] = &[
    BackendSpec {
        key: "cpu",
        label: "CPU（無 GPU 加速）",
        asset: "llama-{tag}-bin-win-cpu-x64.zip",
        extra_assets: &[],
    },
    BackendSpec {
        key: "cuda-12.4",
        label: "CUDA 12.4 (NVIDIA)",
        asset: "llama-{tag}-bin-win-cuda-12.4-x64.zip",
        extra_assets: &["cudart-llama-bin-win-cuda-12.4-x64.zip"],
    },
    BackendSpec {
        key: "cuda-13.3",
        label: "CUDA 13.3 (NVIDIA)",
        asset: "llama-{tag}-bin-win-cuda-13.3-x64.zip",
        extra_assets: &["cudart-llama-bin-win-cuda-13.3-x64.zip"],
    },
    BackendSpec {
        key: "vulkan",
        label: "Vulkan (AMD / Intel / NVIDIA)",
        asset: "llama-{tag}-bin-win-vulkan-x64.zip",
        extra_assets: &[],
    },
    BackendSpec {
        key: "sycl",
        label: "SYCL (Intel Arc)",
        asset: "llama-{tag}-bin-win-sycl-x64.zip",
        extra_assets: &[],
    },
];

const WIN_ARM64_SPECS: &[BackendSpec] = &[BackendSpec {
    key: "cpu",
    label: "CPU (ARM64)",
    asset: "llama-{tag}-bin-win-cpu-arm64.zip",
    extra_assets: &[],
}];

// macOS tarballs nest everything under a top-level "llama-<tag>/" dir — extract_and_swap flattens it.
const MAC_ARM64_SPECS: &[BackendSpec] = &[BackendSpec {
    key: "metal",
    label: "Metal (Apple GPU)",
    asset: "llama-{tag}-bin-macos-arm64.tar.gz",
    extra_assets: &[],
}];

const MAC_X64_SPECS: &[BackendSpec] = &[BackendSpec {
    key: "cpu",
    label: "CPU (Intel)",
    asset: "llama-{tag}-bin-macos-x64.tar.gz",
    extra_assets: &[],
}];

/// Backend matrix for this machine — Windows picks by arch; macOS ships per-arch tarballs.
fn specs_for() -> &'static [BackendSpec] {
    if cfg!(windows) {
        // `ARCH` is "aarch64" on ARM64 Windows, not "arm64".
        if std::env::consts::ARCH == "aarch64" {
            WIN_ARM64_SPECS
        } else {
            WIN_X64_SPECS
        }
    } else if std::env::consts::ARCH == "aarch64" {
        MAC_ARM64_SPECS
    } else {
        MAC_X64_SPECS
    }
}

#[derive(Serialize, Clone)]
pub struct BuildAsset {
    /// install key, e.g. "cuda-12.4" — passed back to install_build
    pub backend: String,
    pub label: String,
    /// release tag, e.g. "b7184"
    pub tag: String,
    /// main archive + extras, in MB
    pub size_mb: u64,
    /// expected SHA256 of the main archive; None if GitHub didn't publish a digest
    pub sha256: Option<String>,
    pub recommended: bool,
}

#[derive(Serialize, Clone)]
pub struct EngineInfo {
    pub name: String,
    pub path: String,
    /// version parsed from the dir name (e.g. "b7184"), if any
    pub version: Option<String>,
}

#[derive(Deserialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>, // "sha256:<hex>" or null on legacy releases
}

#[derive(Deserialize, Clone)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

/// Parse a GitHub asset digest ("sha256:<64 hex>") into lowercase hex; None if absent/invalid.
fn parse_sha256(digest: &str) -> Option<String> {
    let hex = digest.strip_prefix("sha256:")?;
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex.to_lowercase())
}

/// SHA256 of a file, 64KB chunks (blocking — call via spawn_blocking).
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)
            .map_err(|e| format!("讀取檔案失敗: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_of(hasher.finalize()))
}

async fn fetch_release(client: &reqwest::Client, tag: &str) -> Result<GhRelease, String> {
    let url = format!("{REPO_API}/releases/tags/{tag}");
    let resp = client
        .get(&url)
        .header("User-Agent", "chachaanteng")
        .send()
        .await
        .map_err(|e| format!("連唔到 GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API 錯誤 (release {tag}): {}", resp.status()));
    }
    resp.json::<GhRelease>().await.map_err(|e| e.to_string())
}

fn has_platform_assets(r: &GhRelease) -> bool {
    if cfg!(windows) {
        r.assets.iter().any(|a| {
            let n = a.name.to_lowercase();
            n.contains("-bin-win-") || (n.contains("-win-") && n.ends_with(".zip"))
        })
    } else {
        r.assets.iter().any(|a| a.name.to_lowercase().contains("-bin-macos-"))
    }
}

/// The 30 most recent llama.cpp releases, newest first.
async fn fetch_recent_releases(client: &reqwest::Client) -> Result<Vec<GhRelease>, String> {
    let resp = client
        .get(format!("{REPO_API}/releases?per_page=30"))
        .header("User-Agent", "chachaanteng")
        .send()
        .await
        .map_err(|e| format!("連唔到 GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API 錯誤: {}", resp.status()));
    }
    resp.json::<Vec<GhRelease>>().await.map_err(|e| e.to_string())
}

/// llama.cpp occasionally publishes marker releases (e.g. v0.4.0 carrying only
/// nightly-tag.txt) that GitHub's /releases/latest returns; the real binaries live
/// on bNNNN tags. Walk recent releases until one actually ships this platform's archives.
async fn fetch_latest_usable_release(client: &reqwest::Client) -> Result<GhRelease, String> {
    let releases = fetch_recent_releases(client).await?;
    releases
        .into_iter()
        .find(|r| has_platform_assets(r))
        .ok_or_else(|| "最近 30 個 release 都搵唔到呢個平台嘅 binary".to_string())
}

#[derive(Serialize, Clone)]
pub struct EngineVersion {
    /// release tag, e.g. "b7184"
    pub tag: String,
}

/// Recent llama.cpp releases that ship this platform's binaries (newest first) — for the Engine settings tab.
#[tauri::command]
pub async fn list_engine_versions() -> Result<Vec<EngineVersion>, String> {
    let client = &crate::util::API_CLIENT;
    Ok(fetch_recent_releases(&client)
        .await?
        .into_iter()
        .filter(|r| has_platform_assets(r))
        .take(25)
        .map(|r| EngineVersion { tag: r.tag_name })
        .collect())
}

fn recommend_for(hw: &HardwareInfo, spec: &BackendSpec) -> bool {
    if !cfg!(windows) {
        // macOS: the Metal build is the only (and best) choice on Apple Silicon.
        return spec.key == "metal";
    }
    if !hw.nvidia_gpus.is_empty() {
        // 12.4 has the widest driver compatibility; 13.3 needs newer drivers
        spec.key == "cuda-12.4"
    } else if hw.has_other_discrete {
        spec.key == "vulkan"
    } else {
        spec.key == "cpu"
    }
}

fn builds_from_release(hw: &HardwareInfo, release: &GhRelease) -> Vec<BuildAsset> {
    let tag = &release.tag_name;
    let asset_map: HashMap<&str, &GhAsset> =
        release.assets.iter().map(|a| (a.name.as_str(), a)).collect();

    let mut out = Vec::new();
    for spec in specs_for() {
        let main_name = spec.asset.replace("{tag}", tag);
        let Some(main) = asset_map.get(main_name.as_str()) else {
            continue; // this release doesn't ship that backend — skip silently
        };
        let mut size = main.size;
        for extra in spec.extra_assets {
            if let Some(e) = asset_map.get(*extra) {
                size += e.size;
            }
        }
        out.push(BuildAsset {
            backend: spec.key.to_string(),
            label: spec.label.to_string(),
            tag: tag.clone(),
            size_mb: (size / 1_048_576).max(1),
            sha256: parse_sha256(main.digest.as_deref().unwrap_or("")),
            recommended: recommend_for(hw, spec),
        });
    }
    // recommended first, keep matrix order otherwise (stable sort)
    out.sort_by(|a, b| b.recommended.cmp(&a.recommended));
    out
}

#[tauri::command]
pub async fn get_onboarding_data() -> Result<serde_json::Value, String> {
    let hw = detect().await; // async — each probe is timeout-capped inside
    let client = &crate::util::API_CLIENT;
    let release = fetch_latest_usable_release(&client).await?;
    let builds = builds_from_release(&hw, &release);
    Ok(serde_json::json!({
        "hardware": hw,
        "builds": builds,
        "latest_tag": release.tag_name,
    }))
}

pub fn engines_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("engines");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn emit_progress(app: &AppHandle, phase: &str, received: u64, total: Option<u64>, file: &str) {
    let _ = app.emit(
        "build-download-progress",
        serde_json::json!({ "phase": phase, "received": received, "total": total, "file": file }),
    );
}

/// Download one archive with progress events, then verify its SHA256 if known.
async fn download_and_verify(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    filename: &str,
    dest_dir: &Path,
    expected_sha: Option<&str>,
) -> Result<PathBuf, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("下載失敗 ({filename}): HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    // emit immediately so the UI has a denominator from t=0
    emit_progress(app, "downloading", 0, total, filename);

    let dest = dest_dir.join(filename);
    let mut file = tokio::fs::File::create(&dest).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit_bytes: u64 = 0;
    let mut last_emit_at = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        // byte- or time-based throttle so the bar moves on both slow and fast links
        if received - last_emit_bytes > 100_000
            || last_emit_at.elapsed() > std::time::Duration::from_millis(250)
        {
            emit_progress(app, "downloading", received, total, filename);
            last_emit_bytes = received;
            last_emit_at = std::time::Instant::now();
        }
    }
    emit_progress(app, "downloading", received, total, filename);

    // verify before anything touches the install dir (legacy releases may lack a digest → skip)
    if let Some(expected) = expected_sha {
        emit_progress(app, "verifying", received, total, filename);
        let path = dest.clone();
        let expected = expected.to_string();
        let fname = filename.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let got = sha256_file(&path)?;
            if got != expected {
                return Err(format!("SHA256 校驗失敗: {fname}"));
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(dest)
}

/// Extract all archives flat into `staged` (emitting per-file progress), then swap it
/// onto `final_dir` by rename, keeping the previous install until fully in place.
fn extract_and_swap(
    app: &AppHandle,
    archives: &[PathBuf],
    staged: &Path,
    final_dir: &Path,
) -> Result<PathBuf, String> {
    let _ = std::fs::remove_dir_all(staged);
    std::fs::create_dir_all(staged).map_err(|e| e.to_string())?;

    if archives.iter().all(|a| is_zip_archive(a)) {
        extract_zips(app, archives, staged)?;
    } else {
        // macOS tarballs — no cheap entry count, so progress is per-archive.
        for archive in archives {
            let name = archive
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            extract_tar_gz(archive, staged).map_err(|e| format!("解壓失敗 ({name}): {e}"))?;
            emit_progress(app, "extracting", 0, None, &name);
        }
    }

    let server_bin = crate::util::bin_name("llama-server");
    #[cfg(not(windows))]
    if !staged.join(&server_bin).exists() {
        // macOS tarballs nest everything under a top-level "llama-<tag>/" dir — flatten it so the
        // swap logic below sees the binaries at the staging root.
        flatten_staging(staged)?;
    }
    if !staged.join(&server_bin).exists() {
        return Err(format!("解壓完成但搵唔到 {server_bin}"));
    }

    // macOS: don't rely on tar mode bits — make the known tools executable.
    #[cfg(not(windows))]
    for tool in ["llama-server", "llama-bench", "llama-perplexity", "llama-fit-params"] {
        let bin = staged.join(tool);
        if bin.exists() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
        }
    }

    let parent = staged.parent().ok_or("內部路徑錯誤")?;
    let dir_name = final_dir.file_name().unwrap().to_string_lossy().to_string();
    let old = parent.join(format!("{dir_name}.old"));
    if old.exists() {
        let _ = std::fs::remove_dir_all(&old);
    }
    let had_prev = final_dir.exists();
    if had_prev {
        std::fs::rename(final_dir, &old).map_err(|e| format!("備份舊安裝失敗: {e}"))?;
    }
    if let Err(e) = std::fs::rename(staged, final_dir) {
        // put the old install back — a failed update must never leave the user without an engine
        if had_prev {
            let _ = std::fs::rename(&old, final_dir);
        }
        return Err(format!("替換安裝目錄失敗: {e}"));
    }
    if had_prev {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(final_dir.join(server_bin))
}

fn is_zip_archive(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false)
}

/// Extract every zip archive flat into `staged` with a file-count progress bar.
fn extract_zips(app: &AppHandle, archives: &[PathBuf], staged: &Path) -> Result<(), String> {
    // total entry count across all archives (central directory only — cheap) for the progress bar
    let counts: Vec<usize> = archives
        .iter()
        .map(|a| {
            let zf = std::fs::File::open(a).map_err(|e| e.to_string())?;
            zip::ZipArchive::new(zf).map_err(|e| e.to_string()).map(|z| z.len())
        })
        .collect::<Result<Vec<usize>, String>>()?;
    let total_files: u64 = counts.iter().map(|&n| n as u64).sum();

    let mut done: u64 = 0;
    let mut last_emit_at = std::time::Instant::now();
    for (archive, &count) in archives.iter().zip(counts.iter()) {
        let zf = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip_archive = zip::ZipArchive::new(zf).map_err(|e| e.to_string())?;
        for i in 0..count {
            let mut file = zip_archive.by_index(i).map_err(|e| format!("解壓失敗: {e}"))?;
            if let Some(name) = file.enclosed_name() {
                let out_path = staged.join(&name);
                if name.is_dir() {
                    std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
                } else {
                    if let Some(parent) = out_path.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let mut of = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
                    std::io::copy(&mut file, &mut of).map_err(|e| e.to_string())?;
                }
            }
            done += 1;
            if last_emit_at.elapsed() > std::time::Duration::from_millis(250) || i + 1 == count {
                emit_progress(app, "extracting", done, Some(total_files), file.name());
                last_emit_at = std::time::Instant::now();
            }
        }
    }
    Ok(())
}

/// Extract a .tar.gz into `staged`, preserving the archive's directory structure (the tar
/// crate sanitizes entry paths and creates parent dirs). Note: `Entry::unpack` would write
/// every entry to `staged` itself — it takes the full target path, not a root.
fn extract_tar_gz(archive: &Path, staged: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut t = tar::Archive::new(gz);
    for entry in t.entries().map_err(|e| e.to_string())? {
        let mut e = entry.map_err(|e| e.to_string())?;
        e.unpack_in(staged).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move the direct children of staging's single subdirectory up to the staging root. Fails
/// clearly if no single sub-dir holds the server binary (defensive — don't guess layouts).
#[cfg(not(windows))]
fn flatten_staging(staged: &Path) -> Result<(), String> {
    let mut subs: Vec<PathBuf> = std::fs::read_dir(staged)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if subs.len() != 1 {
        return Err("解壓結構唔預期（搵唔到單一頂層目錄）".into());
    }
    let sub = subs.pop().unwrap();
    for e in std::fs::read_dir(&sub).map_err(|e| e.to_string())?.flatten() {
        std::fs::rename(e.path(), staged.join(e.file_name())).map_err(|e| e.to_string())?;
    }
    std::fs::remove_dir_all(&sub).map_err(|e| e.to_string())?;
    Ok(())
}

/// Refuse while any registered server runs from this exe (its args_preview starts with the path).
async fn assert_engine_free(state: &AppState, exe_lc: &str) -> Result<(), String> {
    let servers = state.servers.lock().await;
    for (port, entry) in servers.iter() {
        if entry.args_preview.to_lowercase().starts_with(exe_lc) {
            return Err(format!(
                "engine is in use by the server on port {} — stop it first",
                port
            ));
        }
    }
    Ok(())
}

/// Install a release build: download main + extra archives to temp, verify SHA256,
/// extract into a staging dir, then atomically swap it into engines/<tag>-<backend>.
#[tauri::command]
pub async fn install_build(
    app: AppHandle,
    state: State<'_, AppState>,
    tag: String,
    backend: String,
) -> Result<String, String> {
    // Each OS has its own matrix — a backend key from the wrong OS is an unknown-backend error.
    let spec = specs_for()
        .iter()
        .find(|s| s.key == backend)
        .ok_or_else(|| format!("未知 backend: {backend}"))?;

    let client = &crate::util::STREAM_CLIENT;
    let release = fetch_release(&client, &tag).await?;
    let asset_map: HashMap<String, GhAsset> =
        release.assets.into_iter().map(|a| (a.name.clone(), a)).collect();

    let main_name = spec.asset.replace("{tag}", &tag);
    let Some(main) = asset_map.get(&main_name).cloned() else {
        return Err(format!("Release {tag} 入面搵唔到 {main_name}"));
    };

    // (filename, url, expected sha256) — main first, then extras that exist in the release
    let mut files: Vec<(String, String, Option<String>)> = vec![(
        main_name.clone(),
        main.browser_download_url,
        parse_sha256(&main.digest.unwrap_or_default()),
    )];
    for extra in spec.extra_assets {
        if let Some(e) = asset_map.get(*extra).cloned() {
            files.push((
                (*extra).to_string(),
                e.browser_download_url,
                parse_sha256(&e.digest.unwrap_or_default()),
            ));
        }
    }

    let root = engines_root(&app)?;
    let dir_name = format!("{tag}-{}", spec.key);
    let final_dir = root.join(&dir_name);

    // Refuse while a server runs from this exe — the swap below renames the live install dir away.
    let exe_lc = final_dir
        .join(crate::util::bin_name("llama-server"))
        .to_string_lossy()
        .to_lowercase();
    assert_engine_free(&state, &exe_lc).await?;

    let staged = root.join(format!("{dir_name}.new"));
    // unique per install (pid + tag + backend + time) so concurrent or back-to-back installs of the
    // same build never share a temp dir — even while a previous cleanup is still running.
    let tmpdir = std::env::temp_dir().join(format!(
        "chachaanteng-install-{}-{tag}-{}-{}",
        std::process::id(),
        spec.key,
        crate::util::now_ms()
    ));
    std::fs::create_dir_all(&tmpdir).map_err(|e| e.to_string())?;

    let mut archives: Vec<PathBuf> = Vec::new();
    for (filename, url, sha) in &files {
        // download_and_verify emits its own start/progress events; on failure remove the
        // staging dir too — a `?` here would skip the cleanup below and leak partial zips.
        match download_and_verify(&app, &client, url, filename, &tmpdir, sha.as_deref()).await {
            Ok(p) => archives.push(p),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Err(e);
            }
        }
    }

    emit_progress(&app, "extracting", 0, None, "");
    let app2 = app.clone();
    // staged/final_dir/archives move into the closure; keep one clone for failure cleanup
    let staged_cleanup = staged.clone();
    let result: Result<PathBuf, String> = match tokio::task::spawn_blocking(move || {
        extract_and_swap(&app2, &archives, &staged, &final_dir)
    })
    .await
    {
        Ok(inner) => inner,
        Err(e) => Err(e.to_string()), // join error — the extract task panicked
    };

    // always clean up the temp archives and any leftover staging dir — multi-GB, off the worker
    let failed = result.is_err();
    tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&tmpdir);
        if failed {
            let _ = std::fs::remove_dir_all(&staged_cleanup);
        }
    })
    .await
    .ok();
    result.map(|exe| exe.display().to_string())
}

#[tauri::command]
pub async fn list_installed_engines(app: AppHandle) -> Result<Vec<EngineInfo>, String> {
    let root = engines_root(&app)?;
    let server_bin = crate::util::bin_name("llama-server");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let p = e.path();
            // skip staging leftovers like "b7184-cuda-12.4.new" / ".old"
            if !p.is_dir() || !p.join(&server_bin).exists() {
                continue;
            }
            let Some(file_name) = p.file_name() else {
                continue; // root-terminated path — nothing to name it with
            };
            let name = file_name.to_string_lossy().to_string();
            out.push(EngineInfo {
                version: parse_dir_version(&name),
                path: p.join(&server_bin).display().to_string(),
                name,
            });
        }
    }
    Ok(out)
}

/// Delete an installed engine directory. `path` is the full llama-server.exe path as
/// returned by [`list_installed_engines`]; its parent dir must be a direct child of
/// engines_root, and no running server may be using that exe.
#[tauri::command]
pub async fn delete_installed_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let exe = std::path::PathBuf::from(&path);
    let dir = exe.parent().ok_or_else(|| "invalid engine path".to_string())?;

    // Safety: only allow deleting a directory directly under engines_root.
    let root = engines_root(&app)?;
    let canon_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon_dir.starts_with(&canon_root) {
        return Err("not an installed engine".to_string());
    }

    // Refuse while a server is running from this exe (args_preview starts with the exe path).
    assert_engine_free(&state, &path.to_lowercase()).await?;

    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&canon_dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// "b7184-cuda-12.4" → Some("b7184"); None for custom dirs without a build prefix.
fn parse_dir_version(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes[0] != b'b' {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 1 || (i < bytes.len() && bytes[i] != b'-') {
        return None;
    }
    Some(name[..i].to_string())
}

/// Probe a user-provided llama-server (or the folder containing it): run `--version`
/// and parse the build number. Returns the resolved exe path so the UI can store it.
#[tauri::command]
pub async fn validate_custom_engine(path: String) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    let server_bin = crate::util::bin_name("llama-server");
    let exe = if p.is_dir() { p.join(&server_bin) } else { p };
    if !exe.is_file() {
        return Err(format!("搵唔到 {server_bin}: {}", exe.display()));
    }
    // A hostile/broken exe must not hang the settings dialog — cap the probe.
    let mut cmd = tokio::process::Command::new(&exe);
    crate::util::hide_console_tokio(&mut cmd);
    cmd.arg("--version").kill_on_drop(true); // timeout below drops the command — kill the child with it
    let out = match tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("執行失敗: {e}")),
        Err(_) => return Err("llama-server --version 逾時 (15s)".into()),
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string()
        + &String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Err(format!("llama-server 啟動失敗: {}", text.trim()));
    }
    let version = extract_build_number(&text).map(|n| format!("b{n}"));
    Ok(serde_json::json!({ "ok": true, "version": version, "path": exe.display().to_string() }))
}

/// Find the first standalone "build <digits>" in llama.cpp --version output.
fn extract_build_number(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 5 <= bytes.len() {
        if &lower[i..i + 5] == "build" && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let mut j = i + 5;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            let start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > start {
                return Some(lower[start..j].to_string());
            }
        }
        i += 1;
    }
    None
}
