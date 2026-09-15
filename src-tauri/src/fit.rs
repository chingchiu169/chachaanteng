// Memory estimation via llama.cpp's own `llama-fit-params -fitp on` tool,
// ported from reference backend/services/process_manager.py.

use serde_json::json;
use std::path::PathBuf;

/// Flags that affect the memory estimate and take a value (reference _ESTIMATE_VALUE_FLAGS).
const ESTIMATE_VALUE_FLAGS: &[&str] = &[
    "-t", "--threads", "-tb", "--threads-batch", "-C", "--cpu-mask", "-Cr", "--cpu-range",
    "--cpu-strict", "--prio", "--poll", "-Cb", "--cpu-mask-batch", "-Crb", "--cpu-range-batch",
    "--cpu-strict-batch", "--prio-batch", "--poll-batch", "-c", "--ctx-size", "-n", "--predict",
    "--n-predict", "-b", "--batch-size", "-ub", "--ubatch-size", "--keep", "-fa", "--flash-attn",
    "-p", "--prompt", "-f", "--file", "-bf", "--binary-file", "--rope-scaling", "--rope-scale",
    "--rope-freq-base", "--rope-freq-scale", "--yarn-orig-ctx", "--yarn-ext-factor",
    "--yarn-attn-factor", "--yarn-beta-slow", "--yarn-beta-fast", "-ctk", "--cache-type-k",
    "-ctv", "--cache-type-v", "-dt", "--defrag-thold", "-np", "--parallel", "--rpc", "--numa",
    "-dev", "--device", "-ot", "--override-tensor", "-ncmoe", "--n-cpu-moe", "-ngl",
    "--gpu-layers", "--n-gpu-layers", "-sm", "--split-mode", "-ts", "--tensor-split", "-mg",
    "--main-gpu", "-fit", "--fit", "-fitt", "--fit-target", "-fitc", "--fit-ctx", "--override-kv",
    "--lora", "--lora-scaled", "--control-vector", "--control-vector-scaled",
    "--control-vector-layer-range", "-m", "--model", "-mu", "--model-url", "-dr", "--docker-repo",
    "-hf", "-hfr", "--hf-repo", "-hff", "--hf-file", "-hfv", "-hfrv", "--hf-repo-v", "-hffv",
    "--hf-file-v", "-hft", "--hf-token", "--log-file", "--log-colors", "-lv", "--verbosity",
    "--log-verbosity", "--spec-draft-type-k", "-ctkd", "--cache-type-k-draft",
    "--spec-draft-type-v", "-ctvd", "--cache-type-v-draft",
];

/// Value-less flags that affect the estimate (reference _ESTIMATE_BOOL_FLAGS).
const ESTIMATE_BOOL_FLAGS: &[&str] = &[
    "--swa-full", "--perf", "--no-perf", "-e", "--escape", "--no-escape", "-kvo", "--kv-offload",
    "-nkvo", "--no-kv-offload", "--repack", "-nr", "--no-repack", "--no-host", "--mlock",
    "--mmap", "--no-mmap", "-dio", "--direct-io", "-ndio", "--no-direct-io", "--list-devices",
    "-cmoe", "--cpu-moe", "--check-tensors", "--op-offload", "--no-op-offload", "--log-disable",
    "-v", "--verbose", "--log-verbose", "--offline", "--log-prefix",
];

fn is_int_token(s: &str) -> bool {
    !s.is_empty() && s.parse::<i64>().is_ok()
}

/// Keep only the args that influence memory (reference _memory_estimate_args).
fn filter_memory_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let name = arg.split('=').next().unwrap_or("");

        if name == "-fitp" || name == "--fit-print" {
            // drop any user-supplied -fitp; we append our own at the end
            if !arg.contains('=') && i + 1 < args.len() && !args[i + 1].starts_with('-') {
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if name == "-np" || name == "--parallel" {
            let (raw_value, consumed) = if arg.contains('=') {
                (arg.split_once('=').map(|(_, v)| v.to_string()).unwrap_or_default(), 1)
            } else {
                // Only consume the next token if it actually parses as a value — an
                // unconditional consume made a valueless "-np" swallow the following flag.
                let candidate = args.get(i + 1).cloned().unwrap_or_default();
                if is_int_token(&candidate) {
                    (candidate, 2)
                } else {
                    (String::new(), 1)
                }
            };
            match raw_value.parse::<i64>() {
                Ok(p) if (1..=256).contains(&p) => out.extend(args[i..i + consumed].iter().cloned()),
                _ => {}
            }
            i += consumed;
            continue;
        }

        if ESTIMATE_VALUE_FLAGS.contains(&name) {
            out.push(arg.clone());
            if !arg.contains('=') && i + 1 < args.len() {
                out.push(args[i + 1].clone());
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if ESTIMATE_BOOL_FLAGS.contains(&name) {
            out.push(arg.clone());
            i += 1;
            continue;
        }

        // unknown flag: skip it and its value (if any)
        if arg.contains('=') || i + 1 >= args.len() || args[i + 1].starts_with('-') {
            i += 1;
        } else {
            i += 2;
        }
    }
    out
}

/// Parse `llama-fit-params -fitp on` output: lines of "device model_mib context_mib compute_mib".
fn parse_memory_estimate_output(output: &str) -> Result<serde_json::Value, String> {
    let mut rows = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() != 4 {
            continue;
        }
        let device_ok = parts[0]
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
            && parts[0].chars().all(|c| c.is_ascii_alphanumeric() || "_.-:".contains(c));
        if !device_ok {
            continue;
        }
        let (Ok(model), Ok(context), Ok(compute)) = (
            parts[1].parse::<i64>(),
            parts[2].parse::<i64>(),
            parts[3].parse::<i64>(),
        ) else {
            continue;
        };
        rows.push(json!({
            "device": parts[0],
            "kind": if parts[0].eq_ignore_ascii_case("host") { "ram" } else { "accelerator" },
            "model_mib": model,
            "context_mib": context,
            "compute_mib": compute,
        }));
    }
    if rows.is_empty() {
        return Err("Memory estimate output was not recognized".into());
    }
    let total_model: i64 = rows.iter().map(|r| r["model_mib"].as_i64().unwrap_or(0)).sum();
    let total_context: i64 = rows.iter().map(|r| r["context_mib"].as_i64().unwrap_or(0)).sum();
    let total_compute: i64 = rows.iter().map(|r| r["compute_mib"].as_i64().unwrap_or(0)).sum();
    Ok(json!({
        "ok": true,
        "rows": rows,
        "total_model_mib": total_model,
        "total_context_mib": total_context,
        "total_compute_mib": total_compute,
    }))
}

/// Run `llama-fit-params <filtered launch args> -fitp on` next to the engine exe.
#[tauri::command]
pub async fn estimate_memory(engine_exe: String, args: Vec<String>) -> Result<serde_json::Value, String> {
    let exe = PathBuf::from(&engine_exe);
    let dir = exe.parent().ok_or("invalid engine path")?;
    let fitp = dir.join(crate::util::bin_name("llama-fit-params"));
    if !fitp.exists() {
        return Err("llama-fit-params not found in the engine directory".into());
    }

    let mut cmd_args: Vec<String> = filter_memory_args(&args);
    cmd_args.push("-fitp".to_string());
    cmd_args.push("on".to_string());

    // llama-fit-params accepts a subset of llama-server's params and the accepted set
    // drifts between builds — self-heal by dropping each rejected flag and retrying.
    for _attempt in 0..64 {
        // A wedged fit binary must not hang the estimate UI — cap every attempt.
        let mut cmd = tokio::process::Command::new(&fitp);
        crate::util::hide_console_tokio(&mut cmd);
        cmd.args(&cmd_args).kill_on_drop(true); // timeout below drops the command — kill the child with it
        let out = match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(format!("failed to run llama-fit-params: {e}")),
            Err(_) => return Err("llama-fit-params 逾時 (30s)".into()),
        };
        let text = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        if let Ok(v) = parse_memory_estimate_output(&text) {
            return Ok(v);
        }
        match text.lines().find_map(|l| l.trim().strip_prefix("error: invalid argument:")) {
            Some(bad) => {
                let bad = bad.trim();
                if let Some(pos) = cmd_args.iter().position(|a| a == bad) {
                    cmd_args.remove(pos);
                    // also drop the value token, unless it looks like another flag
                    if pos < cmd_args.len() && !cmd_args[pos].starts_with('-') {
                        cmd_args.remove(pos);
                    }
                } else {
                    return Err("Memory estimate output was not recognized".to_string());
                }
            }
            None => return Err("Memory estimate output was not recognized".to_string()),
        }
    }
    Err("too many invalid arguments for llama-fit-params".to_string())
}
