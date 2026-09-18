//! FR8.2 — Git auto-update for dev installs (ported from the reference's stash-updates flow).
//!
//! Only works when the app was installed from a git checkout: we locate the repo root by walking up
//! from the exe directory, report upstream status (fetch + latest release tag vs what this checkout
//! contains + dirty paths), and pull with an automatic `git stash -u` so uncommitted work is never
//! lost. Release builds have no .git above the exe and simply report "not a git install".
//!
//! The update check compares RELEASES, not branch tips: main moves constantly with unreleased work,
//! but users only care whether a newer tagged release exists. Tags are read via git itself (the repo
//! is private — no unauthenticated GitHub API access).

use serde::Serialize;
use std::path::{Path, PathBuf};

const FETCH_TIMEOUT_SECS: u64 = 120; // slow networks / big repos — matches the reference
const PULL_TIMEOUT_SECS: u64 = 60;

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    /// "abc1234 subject line" of HEAD
    pub head: String,
    /// highest semver tag on origin (e.g. "v0.1.0") — None when the repo has no release tags
    pub latest_release: Option<String>,
    /// last release this checkout contains (`git describe --tags`); empty when HEAD predates all tags
    pub local_version: String,
    /// true when origin has a newer release than what this checkout contains
    pub update_available: bool,
    /// porcelain paths with uncommitted changes
    pub dirty: Vec<String>,
    /// set when `git fetch` failed — the release status may then be stale
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
    let mut cmd = tokio::process::Command::new("git");
    crate::util::hide_console_tokio(&mut cmd);
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        cmd.current_dir(repo)
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

/// "v1.2.3" / "1.2.3" → [1, 2, 3]; None for anything else (prereleases like v1.0.0-rc1 aren't releases).
fn semver_parts(tag: &str) -> Option<Vec<u64>> {
    let t = tag.strip_prefix('v').unwrap_or(tag);
    if t.is_empty() || t.starts_with('.') || t.ends_with('.') || t.contains("..") {
        return None;
    }
    t.split('.').map(|p| p.parse::<u64>()).collect::<Result<Vec<u64>, _>>().ok()
}

/// True when `a` is strictly newer than `b`; missing parts count as 0 ("1.2" == "1.2.0").
fn semver_newer(a: &[u64], b: &[u64]) -> bool {
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Highest semver tag from `for-each-ref` output (one ref name per line); None when no release tags.
fn latest_release_tag(refs: &str) -> Option<String> {
    refs.lines()
        .filter_map(|line| {
            let name = line.trim();
            Some((semver_parts(name)?, name.to_string()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, name)| name)
}

#[tauri::command]
pub async fn git_update_status() -> Result<GitStatus, String> {
    let repo = repo_root()?;
    let branch = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"], 10).await?;
    let head = head_line(&repo).await?;

    // Fetch is best-effort: offline still gets a (possibly stale) local status. --tags keeps the
    // local tag refs in sync so the release comparison below sees what's actually on origin.
    let fetch_note = match run_git(&repo, &["fetch", "origin", "--tags"], FETCH_TIMEOUT_SECS).await {
        Ok(_) => None,
        Err(e) => Some(format!("fetch 失敗 ({e}) — release 狀態可能係舊數據")),
    };

    // Latest release on origin = highest semver tag (fetched above); non-semver tags are ignored.
    let refs = run_git(&repo, &["for-each-ref", "refs/tags", "--format=%(refname:short)"], 10).await?;
    let latest_release = latest_release_tag(&refs);

    // Last release this checkout contains — empty when HEAD predates every tag.
    let local_version = run_git(&repo, &["describe", "--tags", "--abbrev=0", "HEAD"], 10)
        .await
        .unwrap_or_default();

    let update_available = match (&latest_release, semver_parts(&local_version)) {
        (Some(latest), Some(local)) => semver_newer(&semver_parts(latest).unwrap(), &local),
        (Some(_), None) => true, // origin has releases but this checkout contains none of them
        (None, _) => false,
    };

    let porcelain = run_git(&repo, &["status", "--porcelain"], 10).await?;
    Ok(GitStatus {
        head,
        latest_release,
        local_version,
        update_available,
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
pub fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&exe);
    crate::util::hide_console_std(&mut cmd);
    cmd.spawn().map_err(|e| format!("重新啟動失敗: {e}"))?;
    // app.exit (not process::exit) so RunEvent::Exit fires and the cleanup handler kills any
    // running servers/benchmarks/tunnels — a hard exit would orphan them (the tunnel keeps its
    // public URL live with no PID recorded for the next session to reap).
    app.exit(0);
    Ok(())
}
