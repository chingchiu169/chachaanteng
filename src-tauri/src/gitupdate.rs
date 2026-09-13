//! FR8.2 — Git auto-update for dev installs (ported from the reference's stash-updates flow).
//!
//! Only works when the app was installed from a git checkout: we locate the repo root by walking up
//! from the exe directory, report upstream status (fetch + behind/ahead + dirty paths), and pull with
//! an automatic `git stash -u` so uncommitted work is never lost. Release builds have no .git above
//! the exe and simply report "not a git install".

use serde::Serialize;
use std::path::{Path, PathBuf};

const FETCH_TIMEOUT_SECS: u64 = 120; // slow networks / big repos — matches the reference
const PULL_TIMEOUT_SECS: u64 = 60;

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    /// "abc1234 subject line" of HEAD
    pub head: String,
    /// commits local is ahead of / behind upstream (0/0 when no upstream)
    pub ahead: u32,
    pub behind: u32,
    /// porcelain paths with uncommitted changes
    pub dirty: Vec<String>,
    /// set when `git fetch` failed — behind/ahead may then be stale
    pub fetch_note: Option<String>,
}

#[derive(Serialize)]
pub struct GitPullResult {
    /// "abc1234 subject line" of the new HEAD after pulling
    pub head: String,
    /// true when we had to stash uncommitted changes first (they're in `git stash list`)
    pub stashed: bool,
}

/// Walk up from the exe directory looking for a .git entry.
fn repo_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut dir = exe
        .parent()
        .ok_or("can't resolve exe directory")?
        .to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Ok(dir);
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return Err("呢個 app 唔係由 git repo 安裝 (搵唔到 .git)".into()),
        }
    }
}

async fn run_git(repo: &Path, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        tokio::process::Command::new("git")
            .current_dir(repo)
            .args(args)
            // never hang on a credential prompt in the GUI
            .env("GIT_TERMINAL_PROMPT", "0")
            // kill the child when the timeout drops this future — otherwise an orphaned
            // `git pull` keeps running and races our later `stash pop` over index.lock
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("git {} 超時 ({timeout_secs}s)", args.join(" ")))?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "git {} 失敗: {}",
            args.join(" "),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Parse `git status --porcelain` lines into bare paths (handles renames' "old -> new").
fn dirty_paths(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        // every porcelain line is "XY path" (X/Y status chars + space); keep untracked ("??") too,
        // since `stash push -u` and ff-only checkouts both care about them
        .filter(|l| l.len() > 3)
        .map(|l| {
            let path = l.get(3..).unwrap_or(l);
            // renames: "R  old -> new" — keep the new side
            match path.split_once(" -> ") {
                Some((_, new)) => new.to_string(),
                None => path.to_string(),
            }
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// HEAD as "short-hash subject" in a single git spawn.
async fn head_line(repo: &std::path::Path) -> Result<String, String> {
    run_git(repo, &["log", "-1", "--format=%h %s"], 10).await
}

#[tauri::command]
pub async fn git_update_status() -> Result<GitStatus, String> {
    let repo = repo_root()?;
    let branch = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"], 10).await?;
    let head = head_line(&repo).await?;

    // Fetch is best-effort: offline still gets a (possibly stale) local status.
    let fetch_note = match run_git(&repo, &["fetch", "origin", &branch], FETCH_TIMEOUT_SECS).await {
        Ok(_) => None,
        Err(e) => Some(format!("fetch 失敗 ({e}) — behind/ahead 可能係舊數據")),
    };

    let (ahead, behind) = match run_git(&repo, &["rev-list", "--left-right", "--count", "HEAD...@{u}"], 10).await {
        Ok(counts) => {
            // "3\t2" → left = ahead of upstream, right = behind
            let mut parts = counts.split_whitespace();
            (
                parts.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                parts.next().and_then(|n| n.parse().ok()).unwrap_or(0),
            )
        }
        Err(_) => (0, 0), // no upstream configured — not an error for a fresh branch
    };

    let porcelain = run_git(&repo, &["status", "--porcelain"], 10).await?;
    Ok(GitStatus {
        head,
        ahead,
        behind,
        dirty: dirty_paths(&porcelain),
        fetch_note,
        branch,
    })
}

#[tauri::command]
pub async fn git_pull() -> Result<GitPullResult, String> {
    let repo = repo_root()?;
    let porcelain = run_git(&repo, &["status", "--porcelain"], 10).await?;
    let stashed = if dirty_paths(&porcelain).is_empty() {
        false
    } else {
        // protect uncommitted work exactly like the reference's stash-updates.bat
        run_git(
            &repo,
            &[
                "stash",
                "push",
                "-u",
                "-m",
                "chachaanteng auto-stash before pull",
            ],
            30,
        )
        .await
        .map_err(|e| format!("自動 stash 失敗: {e}"))?;
        true
    };

    let result = run_git(&repo, &["pull", "--ff-only"], PULL_TIMEOUT_SECS).await;
    match result {
        Ok(_) => Ok(GitPullResult { head: head_line(&repo).await?, stashed }),
        Err(e) => {
            // restore the user's work before reporting failure — and report honestly if pop fails too
            if stashed {
                return match run_git(&repo, &["stash", "pop"], 30).await {
                    Ok(_) => Err(format!("{e} (已還原 stash)")),
                    Err(pe) => Err(format!(
                        "{e}; stash pop 亦失敗 ({pe}) — 請手動執行 git stash pop 取回更改"
                    )),
                };
            }
            Err(e)
        }
    }
}

/// Relaunch the current exe detached and exit — used after a successful pull so the new code runs.
#[tauri::command]
pub fn restart_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("重新啟動失敗: {e}"))?;
    std::process::exit(0);
}
