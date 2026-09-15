//! Preset storage (FR3): JSON files in app_data/presets with an archive-metadata
//! sidecar file. Ported from the reference presets.py semantics.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const ARCHIVED_FILE: &str = ".preset-archived.json";
/// Keys that must never be persisted inside a preset (credentials).
const SENSITIVE_KEYS: [&str; 2] = ["api_key", "hf_token"];
/// CLI flags whose values are credentials — reject in custom_args.
const SENSITIVE_CLI_FLAGS: [&str; 3] = ["--api-key", "-hft", "--hf-token"];

#[derive(Serialize, Clone)]
pub struct PresetInfo {
    pub name: String,
    pub data: serde_json::Value,
    pub archived: bool,
}

fn presets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = dir.join("presets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Keep only [A-Za-z0-9 ._-], collapse runs of '_', trim leading/trailing junk.
fn sanitize_preset_name(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-') { c } else { '_' })
        .collect();
    // collapse consecutive underscores
    let mut out = String::with_capacity(mapped.len());
    for c in mapped.chars() {
        if c == '_' && out.ends_with('_') {
            continue;
        }
        out.push(c);
    }
    out.trim_matches(|c| c == '.' || c == ' ' || c == '_').to_string()
}

/// Atomic write: tmp file + rename.
fn write_json_atomic(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_archived(dir: &std::path::Path) -> Vec<String> {
    let path = dir.join(ARCHIVED_FILE);
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_archived(dir: &std::path::Path, names: &[String]) {
    let value = serde_json::to_value(names).unwrap_or(serde_json::Value::Null);
    let _ = write_json_atomic(&dir.join(ARCHIVED_FILE), &value);
}

/// Strip credential-bearing keys from preset data. Returns (sanitized, changed).
fn sanitize_preset_data(data: &serde_json::Value) -> (serde_json::Value, bool) {
    let mut changed = false;
    if !data.is_object() {
        return (data.clone(), false);
    }
    let mut out = data.clone();
    if let Some(obj) = out.as_object_mut() {
        for key in SENSITIVE_KEYS {
            if obj.remove(key).is_some() {
                changed = true;
            }
        }
        // custom_args (top-level or under flags) must not carry credential flags
        let mut check_custom = |flags_obj: &mut serde_json::Map<String, serde_json::Value>| {
            if let Some(custom) = flags_obj.get("custom_args").and_then(|v| v.as_str()) {
                if has_sensitive_cli_args(custom) {
                    flags_obj.remove("custom_args");
                    changed = true;
                }
            }
        };
        if let Some(flags_obj) = obj.get_mut("flags").and_then(|v| v.as_object_mut()) {
            check_custom(flags_obj);
        }
        check_custom(obj);
    }
    (out, changed)
}

/// Conservative check: does the raw arg string carry a credential flag?
fn has_sensitive_cli_args(raw: &str) -> bool {
    // crude but safe tokenization on whitespace/quotes — we only need to detect
    // `--api-key`, `-hft`, `--hf-token` as standalone tokens or `flag=value`.
    for token in raw.split(|c: char| c.is_whitespace() || c == '"') {
        let head = token.split('=').next().unwrap_or("");
        if SENSITIVE_CLI_FLAGS.contains(&head) && !head.is_empty() {
            return true;
        }
    }
    false
}

fn preset_path(dir: &std::path::Path, safe_name: &str) -> Option<PathBuf> {
    // name already sanitized — reject anything that could escape the dir
    if safe_name.is_empty() || safe_name.contains('/') || safe_name.contains('\\') || safe_name == "." || safe_name == ".." {
        return None;
    }
    Some(dir.join(format!("{safe_name}.json")))
}

#[tauri::command]
pub async fn list_presets(app: AppHandle) -> Result<Vec<PresetInfo>, String> {
    // Reads every preset file (and may rewrite corrupt ones) — keep it off the async runtime.
    tokio::task::spawn_blocking(move || {
        let dir = presets_dir(&app)?;
        let archived = load_archived(&dir);
        let mut out = Vec::new();

        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            // Skip dotfiles — the archive sidecar plus any stale .preset-created-times.json
            // left behind by older versions.
            if path.file_name().and_then(|s| s.to_str()).is_some_and(|n| n.starts_with('.')) {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue, // skip unreadable/corrupt preset files
            };
            let mut data: serde_json::Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if is_bundle(&data) {
                continue;
            }
            let (sanitized, changed) = sanitize_preset_data(&data);
            if changed {
                let _ = write_json_atomic(&path, &sanitized);
                data = sanitized;
            }
            let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            out.push(PresetInfo {
                archived: archived.iter().any(|n| n == &format!("{name}.json")),
                name,
                data,
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bundle files (exported multi-preset archives) are not single presets.
fn is_bundle(data: &serde_json::Value) -> bool {
    data.get("presets").map(|v| v.is_array()).unwrap_or(false)
}

#[tauri::command]
pub async fn save_preset(
    app: AppHandle,
    name: String,
    data: serde_json::Value,
    overwrite: bool,
) -> Result<String, String> {
    let safe_name = sanitize_preset_name(&name);
    if safe_name.is_empty() {
        return Err("Invalid preset name".into());
    }
    if has_sensitive_cli_args(
        &data.get("custom_args")
            .and_then(|v| v.as_str())
            .or_else(|| data.get("flags").and_then(|f| f.get("custom_args")).and_then(|v| v.as_str()))
            .unwrap_or(""),
    ) {
        return Err(
            "Presets cannot include --api-key, -hft, or --hf-token in Custom Launch Args."
                .into(),
        );
    }

    let dir = presets_dir(&app)?;
    let path = preset_path(&dir, &safe_name).ok_or("Invalid preset name")?;
    if !overwrite && path.exists() {
        return Err("A preset with that name already exists".into());
    }

    let (sanitized, _) = sanitize_preset_data(&data);
    write_json_atomic(&path, &sanitized)?;
    Ok(safe_name)
}

#[tauri::command]
pub async fn rename_preset(app: AppHandle, name: String, new_name: String) -> Result<String, String> {
    let safe = sanitize_preset_name(&name);
    let safe_new = sanitize_preset_name(&new_name);
    if safe.is_empty() || safe_new.is_empty() {
        return Err("Invalid preset name".into());
    }
    let dir = presets_dir(&app)?;
    let from = preset_path(&dir, &safe).ok_or("Invalid preset name")?;
    let to = preset_path(&dir, &safe_new).ok_or("Invalid preset name")?;
    if !from.exists() {
        return Err("Preset not found".into());
    }
    if safe == safe_new {
        return Ok(safe_new);
    }
    if to.exists() && from != to {
        return Err("A preset with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;

    // carry archive flag across the rename
    let mut archived = load_archived(&dir);
    if let Some(pos) = archived.iter().position(|n| n == &format!("{safe}.json")) {
        archived[pos] = format!("{safe_new}.json");
        save_archived(&dir, &archived);
    }
    Ok(safe_new)
}

#[tauri::command]
pub async fn delete_preset(app: AppHandle, name: String) -> Result<(), String> {
    let safe = sanitize_preset_name(&name);
    if safe.is_empty() {
        return Err("Invalid preset name".into());
    }
    let dir = presets_dir(&app)?;
    let path = preset_path(&dir, &safe).ok_or("Invalid preset name")?;
    if !path.exists() {
        return Err("Preset not found".into());
    }
    fs::remove_file(&path).map_err(|e| e.to_string())?;

    let mut archived = load_archived(&dir);
    if let Some(pos) = archived.iter().position(|n| n == &format!("{safe}.json")) {
        archived.remove(pos);
        save_archived(&dir, &archived);
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_presets(app: AppHandle, names: Vec<String>, archived: bool) -> Result<(), String> {
    if names.is_empty() || !names.iter().any(|n| !sanitize_preset_name(n).is_empty()) {
        return Err("names list required".into());
    }
    let dir = presets_dir(&app)?;
    // validate all exist first (all-or-nothing, like the reference)
    let file_names: Vec<String> = names
        .iter()
        .map(|n| {
            let safe = sanitize_preset_name(n);
            preset_path(&dir, &safe)
                .filter(|p| p.exists())
                .ok_or_else(|| "Preset not found".to_string())
                .map(|_| format!("{safe}.json"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut archived_names = load_archived(&dir);
    if archived {
        for name in &file_names {
            if !archived_names.contains(name) {
                archived_names.push(name.clone());
            }
        }
    } else {
        archived_names.retain(|n| !file_names.contains(n));
    }
    save_archived(&dir, &archived_names);
    Ok(())
}
