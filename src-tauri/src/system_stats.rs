//! FR6.1 / FR6.2 — read-only CPU / RAM / disk telemetry + NVIDIA GPU polling.
//!
//! Design (mirrors the reference `system_stats.py`):
//! * Read-only. Never installs, elevates, or runs a package manager. The only
//!   external call is a bounded `nvidia-smi` query against the driver's own tool.
//! * CPU% and disk usage come from cumulative Windows counters; CPU busy % is a
//!   delta between two samples (the first sample has no baseline → `null`).
//! * A short-lived (~2s) response cache means a cold GPU probe is paid at most
//!   once per Monitor poll cycle. `refresh=true` bypasses the cache (Recheck).

use crate::util::now_ms;
use serde::Serialize;
use std::ffi::c_void;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Windows FFI (kernel32 — linked by default on MSVC targets)
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

#[repr(C)]
struct MEMORYSTATUSEX {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

extern "system" {
    fn GetSystemTimes(
        lp_idle_time: *mut FILETIME,
        lp_kernel_time: *mut FILETIME,
        lp_user_time: *mut FILETIME,
    ) -> i32;
    fn GlobalMemoryStatusEx(lp_buf: *mut MEMORYSTATUSEX) -> i32;
    fn GetDiskFreeSpaceExW(
        lp_directory_name: *const u16,
        lp_free_bytes_available_to_caller: *mut u64,
        lp_total_number_of_bytes: *mut u64,
        lp_total_number_of_free_bytes: *mut u64,
    ) -> i32;
}

// ---------------------------------------------------------------------------
// Performance Data Helper (pdh.dll) — whole-system disk throughput
// ---------------------------------------------------------------------------

#[link(name = "pdh")]
extern "system" {
    fn PdhOpenQueryW(
        sz_data_source: *const u16,
        dw_user_data: usize,
        ph_query: *mut *mut c_void,
    ) -> i32;
    fn PdhAddEnglishCounterW(
        h_query: *mut c_void,
        sz_full_counter_path: *const u16,
        dw_user_data: usize,
        ph_counter: *mut *mut c_void,
    ) -> i32;
    fn PdhCollectQueryData(h_query: *mut c_void) -> i32;
    fn PdhCloseQuery(h_query: *mut c_void) -> i32;
    fn PdhGetFormattedCounterValue(
        h_counter: *mut c_void,
        dw_format: u32,
        lpdw_type: *mut u32,
        p_value: *mut PdhFmtCounterValue,
    ) -> i32;
}

/// `PDH_FMT_DOUBLE` from um/pdh.h — the value comes back as a C double.
const PDH_FMT_DOUBLE: u32 = 0x0000_0200;

/// Layout of `PDH_FMT_COUNTERVALUE`: status DWORD + union whose first member is a double.
#[repr(C)]
struct PdhFmtCounterValue {
    c_status: u32,
    value: f64,
}

/// One open PDH query + counter for a rate counter (closed on drop).
struct PdhRate {
    query: *mut c_void,
    counter: *mut c_void,
}

// PDH handles are only ever touched behind the `SysStatsCache` mutex, so manual Send/Sync is sound.
unsafe impl Send for PdhRate {}
unsafe impl Sync for PdhRate {}

impl Drop for PdhRate {
    fn drop(&mut self) {
        if !self.query.is_null() {
            unsafe { PdhCloseQuery(self.query) };
        }
    }
}

/// Whole-system disk throughput via the `\PhysicalDisk(_Total)` rate counters — the same
/// source Task Manager reads. English counter names keep this working on localized Windows.
struct DiskIo {
    read: PdhRate,
    write: PdhRate,
}

fn open_pdh_rate(counter_path: &str) -> Option<PdhRate> {
    let mut query = std::ptr::null_mut();
    // NULL data source = local computer.
    if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) } != 0 || query.is_null() {
        return None;
    }
    let wide: Vec<u16> = counter_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut counter = std::ptr::null_mut();
    if unsafe { PdhAddEnglishCounterW(query, wide.as_ptr(), 0, &mut counter) } != 0 || counter.is_null()
    {
        unsafe { PdhCloseQuery(query) };
        return None;
    }
    // Seed collect — rate counters report nothing until two samples exist.
    unsafe { PdhCollectQueryData(query) };
    Some(PdhRate { query, counter })
}

impl DiskIo {
    fn open() -> Option<Self> {
        Some(Self {
            read: open_pdh_rate(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec")?,
            write: open_pdh_rate(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec")?,
        })
    }

    /// `(read, write)` bytes/sec since the previous sample; `None` until PDH has data.
    fn sample(&mut self) -> (Option<f64>, Option<f64>) {
        let read = Self::collect(&mut self.read);
        let write = Self::collect(&mut self.write);
        (read, write)
    }

    fn collect(rate: &mut PdhRate) -> Option<f64> {
        unsafe { PdhCollectQueryData(rate.query) };
        let mut v = PdhFmtCounterValue { c_status: u32::MAX, value: 0.0 };
        if unsafe {
            PdhGetFormattedCounterValue(rate.counter, PDH_FMT_DOUBLE, std::ptr::null_mut(), &mut v)
        } != 0
        {
            return None;
        }
        // CStatus carries the per-sample status (e.g. "no data yet") even when the call returns 0.
        if v.c_status != 0 || !v.value.is_finite() || v.value < 0.0 {
            return None;
        }
        Some(v.value)
    }
}

/// Cumulative CPU counters via `GetSystemTimes`. Kernel time already includes
/// idle, so total = kernel + user. Returns `(total_ticks, idle_ticks)`.
fn cpu_counters() -> Option<(u64, u64)> {
    let mut idle = FILETIME { low: 0, high: 0 };
    let mut kernel = FILETIME { low: 0, high: 0 };
    let mut user = FILETIME { low: 0, high: 0 };
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let total = kernel.to_u64() + user.to_u64();
    let idle_ticks = idle.to_u64();
    if total <= 0 || idle_ticks > total {
        return None;
    }
    Some((total, idle_ticks))
}

/// System RAM as `(used_bytes, total_bytes)` via `GlobalMemoryStatusEx`.
fn memory() -> Option<(u64, u64)> {
    let mut status = MEMORYSTATUSEX {
        dw_length: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    let total = status.ull_total_phys;
    let available = status.ull_avail_phys;
    if total <= 0 || available > total {
        return None;
    }
    Some((total - available, total))
}

/// Disk usage `(used_bytes, total_bytes)` for the drive holding `path`.
fn disk_usage(path: &str) -> Option<(u64, u64)> {
    // GetDiskFreeSpaceExW wants a directory; the drive root ("C:\") is enough.
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    if unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free_total)
    } == 0
    {
        return None;
    }
    if total <= 0 || free_total > total {
        return None;
    }
    Some((total - free_total, total))
}

/// CPU busy % from cumulative counter deltas. `None` on rollback or a
/// non-positive total delta (the caller keeps the baseline in that case).
fn cpu_percent(prev: Option<(u64, u64)>, curr: (u64, u64)) -> Option<f64> {
    let (pt, pi) = prev?;
    let (ct, ci) = curr;
    if ct <= pt || ci < pi || ci > ct || pi > pt {
        return None;
    }
    let delta_total = ct - pt;
    let delta_idle = ci - pi;
    if delta_total == 0 {
        return None;
    }
    let busy = (delta_total - delta_idle) as f64 / delta_total as f64 * 100.0;
    Some(busy.clamp(0.0, 100.0))
}

// ---------------------------------------------------------------------------
// NVIDIA probe
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GpuStats {
    pub name: String,
    pub utilization_percent: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub temperature_c: Option<f64>,
    pub power_watts: Option<f64>,
}

fn parse_f(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("n/a") {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

const MIB: u64 = 1024 * 1024;

/// One bounded `nvidia-smi` CSV query. Missing tool / no GPU → empty vec, never an error.
async fn probe_nvidia() -> Vec<GpuStats> {
    let exe = resolve_nvidia_smi();
    let Some(exe) = exe else {
        return Vec::new();
    };

    let mut cmd = tokio::process::Command::new(&exe);
    crate::util::hide_console_tokio(&mut cmd);
    let fut = cmd
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ])
        // don't leave an orphaned nvidia-smi behind when the 2 s timeout fires
        .kill_on_drop(true)
        .output();

    let out = match tokio::time::timeout(Duration::from_secs(2), fut).await {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() < 6 {
                return None;
            }
            Some(GpuStats {
                name: parts[0].to_string(),
                utilization_percent: parse_f(parts[1]),
                memory_used_bytes: parse_f(parts[2]).map(|v| (v * MIB as f64) as u64),
                memory_total_bytes: parse_f(parts[3]).map(|v| (v * MIB as f64) as u64),
                temperature_c: parse_f(parts[4]),
                power_watts: parse_f(parts[5]),
            })
        })
        .collect()
}

/// `nvidia-smi` ships with the driver; look on PATH plus known locations.
pub(crate) fn resolve_nvidia_smi() -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join("nvidia-smi.exe");
        if cand.is_file() {
            return Some(cand.to_string_lossy().into_owned());
        }
    }
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    for cand in [
        format!("{sysroot}\\System32\\nvidia-smi.exe"),
        r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe".to_string(),
    ] {
        if std::path::Path::new(&cand).is_file() {
            return Some(cand);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Response + cache state
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct SystemStats {
    pub sampled_at_ms: i64,
    /// CPU busy % (null on the first sample — no baseline yet).
    pub cpu_percent: Option<f64>,
    pub ram_used_bytes: u64,
    pub ram_total_bytes: u64,
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    /// Whole-system disk throughput (bytes/sec) from PDH rate counters; null until the first valid sample.
    pub disk_read_bps: Option<f64>,
    pub disk_write_bps: Option<f64>,
    /// Empty when nvidia-smi is absent or no NVIDIA GPU is present.
    pub gpus: Vec<GpuStats>,
}

const CACHE_TTL: Duration = Duration::from_secs(2);

pub struct SysStatsCache {
    prev_cpu: Option<(u64, u64)>,
    cached: Option<(Instant, SystemStats)>,
    /// Lazily opened PDH rate counters for whole-system disk throughput.
    disk_io: Option<DiskIo>,
}

impl Default for SysStatsCache {
    fn default() -> Self {
        Self { prev_cpu: None, cached: None, disk_io: None }
    }
}

/// FR6.1/FR6.2 — one Monitor payload, served from a short-lived cache unless `refresh`.
#[tauri::command]
pub async fn get_system_stats(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    refresh: bool,
) -> Result<SystemStats, String> {
    // Fast path: fresh cached sample.
    {
        let cache = state.sys_stats.lock().await;
        if !refresh {
            if let Some((at, data)) = &cache.cached {
                if at.elapsed() < CACHE_TTL {
                    return Ok(data.clone());
                }
            }
        }
    }

    // Fast counter reads (FFI) — cheap, done inline.
    let cpu_now = cpu_counters();
    let ram = memory().unwrap_or((0, 0));
    let disk_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let disk = disk_usage(&disk_path).unwrap_or((0, 0));

    // CPU% needs the previous sample; update the baseline under the lock.
    let cpu_percent = {
        let mut cache = state.sys_stats.lock().await;
        let pct = match (cache.prev_cpu, cpu_now) {
            (Some(prev), Some(curr)) => cpu_percent(Some(prev), curr),
            _ => None,
        };
        if let Some(c) = cpu_now {
            cache.prev_cpu = Some(c);
        }
        pct
    };

    // Whole-system disk throughput — lazily open the PDH queries, then advance + read.
    let (disk_read_bps, disk_write_bps) = {
        let mut cache = state.sys_stats.lock().await;
        if cache.disk_io.is_none() {
            cache.disk_io = DiskIo::open();
        }
        match cache.disk_io.as_mut() {
            Some(io) => io.sample(),
            None => (None, None),
        }
    };

    // Slow GPU probe runs outside the lock so it can't stall other polls.
    let gpus = probe_nvidia().await;

    let data = SystemStats {
        sampled_at_ms: now_ms(),
        cpu_percent,
        ram_used_bytes: ram.0,
        ram_total_bytes: ram.1,
        disk_used_bytes: disk.0,
        disk_total_bytes: disk.1,
        disk_read_bps,
        disk_write_bps,
        gpus,
    };

    {
        let mut cache = state.sys_stats.lock().await;
        cache.cached = Some((Instant::now(), data.clone()));
    }
    Ok(data)
}
