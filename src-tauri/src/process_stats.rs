//! Per-server process telemetry — CPU% / working-set RAM for a running llama-server PID, plus
//! per-process NVIDIA GPU utilization (pmon) and VRAM (query-compute-apps).
//!
//! Read-only; mirrors system_stats.rs conventions: raw FFI, bounded `nvidia-smi` probes with
//! kill_on_drop + 2 s timeout, None/empty on any failure. CPU% is a delta between samples — the
//! first sample for a PID has no baseline → null.

use serde::Serialize;
use std::ffi::c_void;
use std::time::{Duration, Instant};
use tauri::State;

// ---------------------------------------------------------------------------
// Windows FFI (kernel32 + psapi)
// ---------------------------------------------------------------------------

#[repr(C)]
struct FILETIME {
    low: u32,
    high: u32,
}

impl FILETIME {
    fn to_u64(&self) -> u64 {
        ((self.high as u64) << 32) | (self.low as u64)
    }
}

/// PROCESS_MEMORY_COUNTERS from psapi — only the fields we read.
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: *mut c_void,
    working_set_size: *mut c_void,
    quota_peak_paged_pool_usage: *mut c_void,
    quota_paged_pool_usage: *mut c_void,
    quota_peak_non_paged_pool_usage: *mut c_void,
    quota_non_paged_pool_usage: *mut c_void,
    page_file_usage: *mut c_void,
    peak_page_file_usage: *mut c_void,
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
const PROCESS_VM_READ: u32 = 0x0010;

extern "system" {
    fn OpenProcess(dwdesiredaccess: u32, binherithandle: i32, dwprocessid: u32) -> *mut c_void;
    fn CloseHandle(hobject: *mut c_void) -> i32;
    fn GetProcessTimes(
        hprocess: *mut c_void,
        lpkerneltimes: *mut FILETIME,
        lpusertimes: *mut FILETIME,
        lpcreationtime: *mut FILETIME,
        lpexittime: *mut FILETIME,
    ) -> i32;
}

#[link(name = "psapi")]
extern "system" {
    fn K32GetProcessMemoryInfo(
        hprocess: *mut c_void,
        ppsmemcounters: *mut ProcessMemoryCounters,
        cb: u32,
    ) -> i32;
}

/// Cumulative user+kernel CPU time of a process in 100 ns units (None if the handle can't be opened).
fn process_cpu_time_100ns(pid: u32) -> Option<u64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        // All four FILETIMEs must be valid pointers — the API does not guarantee NULL tolerance.
        let mut kernel = FILETIME { low: 0, high: 0 };
        let mut user = FILETIME { low: 0, high: 0 };
        let mut creation = FILETIME { low: 0, high: 0 };
        let mut exit = FILETIME { low: 0, high: 0 };
        let ok = GetProcessTimes(h, &mut kernel, &mut user, &mut creation, &mut exit);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(kernel.to_u64() + user.to_u64())
    }
}

/// Working-set size in bytes (None on failure).
fn process_working_set_bytes(pid: u32) -> Option<u64> {
    unsafe {
        // K32GetProcessMemoryInfo needs PROCESS_QUERY_INFORMATION — VM_READ alone is not enough.
        let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut counters = std::mem::zeroed::<ProcessMemoryCounters>();
        counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        let ok = K32GetProcessMemoryInfo(h, &mut counters, counters.cb);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(counters.working_set_size as usize as u64)
    }
}

/// Per-PID CPU baseline — cumulative 100 ns units + wall-clock instant of the last sample.
static CPU_BASELINES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, (Instant, u64)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// CPU busy % across all logical processors; None on the first sample or a stale baseline.
fn process_cpu_percent(pid: u32, num_procs: usize) -> Option<f64> {
    let now_units = match process_cpu_time_100ns(pid) {
        Some(u) => u,
        // Process gone (or unreadable) — drop any stale baseline so the map can't grow forever.
        None => {
            if let Ok(mut b) = CPU_BASELINES.lock() {
                b.remove(&pid);
            }
            return None;
        }
    };
    let mut baselines = CPU_BASELINES.lock().ok()?;
    let prev = match baselines.get(&pid).copied() {
        Some(p) => p,
        None => {
            // First sample for this PID — store the baseline, no measurement yet.
            baselines.insert(pid, (Instant::now(), now_units));
            return None;
        }
    };
    if now_units < prev.1 {
        // PID was recycled (process restarted) — reset the baseline, no measurement this tick.
        baselines.insert(pid, (Instant::now(), now_units));
        return None;
    }
    let dt_ms = prev.0.elapsed().as_secs_f64() * 1000.0;
    baselines.insert(pid, (Instant::now(), now_units));
    if dt_ms <= 0.0 {
        return None;
    }
    // FILETIME units are 100 ns → ms: /10_000
    let cpu_ms = (now_units - prev.1) as f64 / 10_000.0;
    Some((cpu_ms / dt_ms * 100.0 / num_procs.max(1) as f64).min(100.0))
}

// ---------------------------------------------------------------------------
// Per-process NVIDIA stats (bounded nvidia-smi probes — same pattern as system_stats::probe_nvidia)
// ---------------------------------------------------------------------------

const MIB: u64 = 1024 * 1024;

/// pmon table: header lines start with '#'; data rows are whitespace-separated
/// `gpu pid type sm [mem enc dec fps]` — the SM column is always index 3.
fn parse_pmon_sm(out: &str, pid: u32) -> Option<f64> {
    out.lines().find_map(|line| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            return None;
        }
        let parts: Vec<&str> = t.split_whitespace().collect();
        if parts.len() < 4 || parts[1].parse::<u32>().ok()? != pid {
            return None;
        }
        parts[3].parse::<f64>().ok().filter(|v| v.is_finite())
    })
}

/// (SM utilization %, VRAM bytes) for one PID. Both None when nvidia-smi is absent or the PID
/// isn't a compute app on any GPU.
async fn probe_process_gpu(pid: u32) -> (Option<f64>, Option<u64>) {
    let Some(exe) = crate::system_stats::resolve_nvidia_smi() else {
        return (None, None);
    };

    // Exact VRAM for this PID — CSV is trivially parseable.
    let mem_fut = tokio::process::Command::new(&exe)
        .args(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
        // don't leave an orphaned nvidia-smi behind when the 2 s timeout fires
        .kill_on_drop(true)
        .output();
    // Per-process SM utilization — pmon prints a fixed table; -c 1 = one sample.
    let util_fut = tokio::process::Command::new(&exe)
        .args(["pmon", "-c", "1", "-s", "u"])
        .kill_on_drop(true)
        .output();

    let (mem_out, util_out) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(2), mem_fut),
        tokio::time::timeout(Duration::from_secs(2), util_fut),
    );

    let gpu_mem = match mem_out {
        Ok(Ok(o)) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .find_map(|line| {
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() < 2 || parts[0].parse::<u32>().ok()? != pid {
                    return None;
                }
                Some((parts[1].parse::<f64>().ok()? * MIB as f64) as u64)
            }),
        _ => None,
    };

    let gpu_util = match util_out {
        Ok(Ok(o)) if o.status.success() => parse_pmon_sm(&String::from_utf8_lossy(&o.stdout), pid),
        _ => None,
    };

    (gpu_util, gpu_mem)
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProcessStats {
    /// CPU busy % across all logical processors; null on the first sample or if the handle can't be opened.
    pub cpu_percent: Option<f64>,
    /// Working-set RAM in bytes; 0 when it can't be read.
    pub ram_bytes: u64,
    /// Per-process GPU SM utilization % (nvidia-smi pmon); null without NVIDIA / not a compute app.
    pub gpu_util_percent: Option<f64>,
    /// Per-process VRAM in bytes; null without NVIDIA / not a compute app.
    pub gpu_mem_bytes: Option<u64>,
}

/// Per-server process telemetry for one registered port (the PID is resolved from the server registry).
#[tauri::command]
pub async fn server_process_stats(state: State<'_, crate::AppState>, port: u16) -> Result<ProcessStats, String> {
    let Some(pid) = state.servers.lock().await.get(&port).map(|e| e.pid) else {
        return Err(format!("No server on port {port}"));
    };

    // GPU probes are the slow part (~1 s for pmon's sample window); run them first.
    let (gpu_util, gpu_mem) = probe_process_gpu(pid).await;

    // CPU% + working set are fast FFI reads — no need to leave the runtime thread.
    let procs = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    Ok(ProcessStats {
        cpu_percent: process_cpu_percent(pid, procs),
        ram_bytes: process_working_set_bytes(pid).unwrap_or(0),
        gpu_util_percent: gpu_util,
        gpu_mem_bytes: gpu_mem,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The FFI path must not crash when run headless — a segfault here is what took the app down at startup.
    #[test]
    fn own_pid_cpu_and_ram() {
        let pid = std::process::id();
        // First sample: no baseline yet → None, but the OpenProcess/GetProcessTimes path still runs.
        assert!(process_cpu_percent(pid, 8).is_none());
        std::thread::sleep(Duration::from_millis(100));
        let v = process_cpu_percent(pid, 8);
        assert!(v.is_some(), "second sample should have a baseline");
        assert!(process_working_set_bytes(pid).unwrap_or(0) > 0, "own working set must be readable");
    }

    #[test]
    fn pmon_sm_parse() {
        let out = "# gpu   pid type sm\n# 1s sample interval\n  0      424 C   95\n  0     999 C    3\n";
        assert_eq!(parse_pmon_sm(out, 424), Some(95.0));
        assert_eq!(parse_pmon_sm(out, 999), Some(3.0));
        assert_eq!(parse_pmon_sm(out, 1), None);
    }
}
