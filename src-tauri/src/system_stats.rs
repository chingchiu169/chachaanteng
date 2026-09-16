//! FR6.1 / FR6.2 — read-only CPU / RAM / disk telemetry + NVIDIA GPU polling.
//!
//! Design (mirrors the reference `system_stats.py`):
//! * Read-only. Never installs, elevates, or runs a package manager. The only
//!   external call is a bounded `nvidia-smi` query against the driver's own tool.
//! * CPU% and disk usage come from cumulative OS counters (Windows FFI; Mach + IOKit on
//!   macOS); CPU busy % is a delta between two samples (the first sample has no baseline → `null`).
//! * A short-lived (~2s) response cache means a cold GPU probe is paid at most
//!   once per Monitor poll cycle. `refresh=true` bypasses the cache (Recheck).

use crate::util::{now_ms, MIB};
use serde::Serialize;
use std::ffi::c_void;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Windows FFI (kernel32 — linked by default on MSVC targets)
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[repr(C)]
struct FILETIME {
    low: u32,
    high: u32,
}

#[cfg(windows)]
impl FILETIME {
    fn to_u64(&self) -> u64 {
        ((self.high as u64) << 32) | (self.low as u64)
    }
}

#[cfg(windows)]
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

#[cfg(windows)]
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

#[cfg(windows)]
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
#[cfg(windows)]
const PDH_FMT_DOUBLE: u32 = 0x0000_0200;

/// Layout of `PDH_FMT_COUNTERVALUE`: status DWORD + union whose first member is a double.
#[cfg(windows)]
#[repr(C)]
struct PdhFmtCounterValue {
    c_status: u32,
    value: f64,
}

/// One open PDH query + counter for a rate counter (closed on drop).
#[cfg(windows)]
struct PdhRate {
    query: *mut c_void,
    counter: *mut c_void,
}

// PDH handles are only ever touched behind the `SysStatsCache` mutex, so manual Send/Sync is sound.
#[cfg(windows)]
unsafe impl Send for PdhRate {}
#[cfg(windows)]
unsafe impl Sync for PdhRate {}

#[cfg(windows)]
impl Drop for PdhRate {
    fn drop(&mut self) {
        if !self.query.is_null() {
            unsafe { PdhCloseQuery(self.query) };
        }
    }
}

/// Whole-system disk throughput via the `\PhysicalDisk(_Total)` rate counters — the same
/// source Task Manager reads. English counter names keep this working on localized Windows.
#[cfg(windows)]
struct DiskIo {
    read: PdhRate,
    write: PdhRate,
}

#[cfg(windows)]
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

#[cfg(windows)]
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
#[cfg(windows)]
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

/// Cumulative CPU counters on macOS via Mach `host_statistics(HOST_CPU_LOAD_INFO)` — four
/// cumulative tick counters (user/system/idle/nice); total = all four. Returns `(total, idle)`.
#[cfg(not(windows))]
fn cpu_counters() -> Option<(u64, u64)> {
    extern "C" {
        // mach_host_self returns the host port directly. A hand-rolled `host_self(*mut u32)`
        // declaration does NOT work on macOS — that symbol returns the port in the return
        // register and never writes *out, so the out-param stays 0 and every later call fails.
        fn mach_host_self() -> u32;
        fn host_statistics(target_host: u32, flavor: i32, info: *mut c_void, count: *mut u32) -> i32;
    }

    /// `host_cpu_load_info_data_t` — four natural_t tick counters.
    #[repr(C)]
    struct HostCpuLoadInfo {
        user: u32,
        system: u32,
        idle: u32,
        nice: u32,
    }

    const HOST_CPU_LOAD_INFO: i32 = 3;

    let host = unsafe { mach_host_self() };
    if host == 0 {
        return None;
    }
    let mut info = HostCpuLoadInfo { user: 0, system: 0, idle: 0, nice: 0 };
    let mut count: u32 = 4; // CPU_STATE_MAX
    if unsafe {
        host_statistics(
            host,
            HOST_CPU_LOAD_INFO,
            &mut info as *mut _ as *mut c_void,
            &mut count,
        )
    } != 0
    {
        return None;
    }
    let total = (info.user + info.system + info.idle + info.nice) as u64;
    if total == 0 {
        return None;
    }
    Some((total, info.idle as u64))
}

/// RAM sample — used/total plus the macOS Activity-Monitor-style breakdown (None on Windows,
/// which has no equivalent source for those categories).
#[derive(Clone, Copy)]
struct RamSample {
    used: u64,
    total: u64,
    /// App Memory — anonymous pages.
    app: Option<u64>,
    /// System core — wired-down pages (kernel + drivers + window server).
    wired: Option<u64>,
    /// Compressed memory (pages stored in the compressor).
    compressed: Option<u64>,
    /// Swap space in use.
    swap_used: Option<u64>,
}

/// System RAM via `GlobalMemoryStatusEx`.
#[cfg(windows)]
fn memory() -> RamSample {
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
        return RamSample { used: 0, total: 0, app: None, wired: None, compressed: None, swap_used: None };
    }
    let total = status.ull_total_phys;
    let available = status.ull_avail_phys;
    if total <= 0 || available > total {
        return RamSample { used: 0, total: 0, app: None, wired: None, compressed: None, swap_used: None };
    }
    RamSample { used: total - available, total, app: None, wired: None, compressed: None, swap_used: None }
}

/// System RAM on macOS — total via the `hw.memsize` sysctl, the Activity-Monitor-style
/// breakdown from `vm_stat` (the same counters Activity Monitor reads):
/// App Memory = anonymous pages, System core = wired-down pages, Compressed = compressor
/// occupancy. "Used" is their sum (Activity Monitor's composite), not total − free — macOS
/// keeps file-backed cache in "free" that it would evict on demand. Swap comes from the
/// `vm.swapusage` sysctl (`xsw_usage_t`, three u64s).
#[cfg(not(windows))]
fn memory() -> RamSample {
    extern "C" {
        fn sysctlbyname(
            name: *const i8,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *const c_void,
            newlen: usize,
        ) -> i32;
    }

    /// `xsw_usage_t` from vm/vm_page.h.
    #[repr(C)]
    struct XswUsage {
        xu_total: u64,
        xu_avail: u64,
        xu_used: u64,
    }

    let mut total: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    if unsafe {
        sysctlbyname(
            b"hw.memsize\0".as_ptr() as *const i8,
            &mut total as *mut _ as *mut c_void,
            &mut len,
            std::ptr::null(),
            0,
        )
    } != 0
        || total == 0
    {
        return RamSample { used: 0, total: 0, app: None, wired: None, compressed: None, swap_used: None };
    }

    // Swap — independent of vm_stat, so it survives a vm_stat parse failure.
    let mut sw = XswUsage { xu_total: 0, xu_avail: 0, xu_used: 0 };
    let mut sw_len = std::mem::size_of::<XswUsage>();
    let swap_used = if unsafe {
        sysctlbyname(
            b"vm.swapusage\0".as_ptr() as *const i8,
            &mut sw as *mut _ as *mut c_void,
            &mut sw_len,
            std::ptr::null(),
            0,
        )
    } == 0
    {
        Some(sw.xu_used)
    } else {
        None
    };

    // vm_stat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)" + "Pages free: N."
    let out = match std::process::Command::new("vm_stat").output() {
        Ok(o) => o,
        Err(_) => return RamSample { used: total, total, app: None, wired: None, compressed: None, swap_used },
    };
    let text = String::from_utf8_lossy(&out.stdout);
    // The number is followed by " bytes)" — take the first whitespace-delimited token.
    let page_size: u64 = match text.lines().find_map(|l| {
        let rest = l.split_once("page size of ")?.1;
        rest.split_whitespace().next()?.parse().ok()
    }) {
        Some(ps) if ps > 0 => ps,
        _ => return RamSample { used: total, total, app: None, wired: None, compressed: None, swap_used },
    };
    // "Label:            N." — trailing dot + variable whitespace.
    let pages = |prefix: &str| -> Option<u64> {
        text.lines().find_map(|l| {
            let rest = l.trim().strip_prefix(prefix)?;
            rest.trim().trim_end_matches('.').parse().ok()
        })
    };

    let app = pages("Anonymous pages:").map(|p| p * page_size);
    let wired = pages("Pages wired down:").map(|p| p * page_size);
    let compressed = pages("Pages occupied by compressor:").map(|p| p * page_size);
    // Used = the three categories (Activity Monitor's composite). Missing pieces fall back to 0.
    let used = [app, wired, compressed].iter().fold(0u64, |acc, v| acc + v.unwrap_or(0));

    RamSample { used, total, app, wired, compressed, swap_used }
}

/// Disk usage `(used_bytes, total_bytes)` for the drive holding `path`.
#[cfg(windows)]
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

/// Disk usage `(used_bytes, total_bytes)` of the system volume via `statfs("/")`.
#[cfg(not(windows))]
fn disk_usage(_path: &str) -> Option<(u64, u64)> {
    // The FULL platform struct must be provided: macOS's statfs is ~2 KB (it embeds two
    // 1024-byte mount-name arrays) and the C call writes every field regardless of what we
    // read — a hand-rolled prefix buffer overflows the stack and segfaulted the Monitor poll.
    let mut buf = unsafe { std::mem::zeroed::<libc::statfs>() };
    if unsafe { libc::statfs(b"/\0".as_ptr() as *const i8, &mut buf) } != 0 || buf.f_blocks == 0 {
        return None;
    }
    let bsize = buf.f_bsize as u64;
    Some((buf.f_blocks.saturating_sub(buf.f_bfree) * bsize, buf.f_blocks * bsize))
}

/// First run of ASCII digits after `key` in `line` (ioreg prints `"Key"=123,` inline).
#[cfg(not(windows))]
fn digits_after(line: &str, key: &str) -> Option<u64> {
    let rest = line.split_once(key)?;
    let digits: String = rest
        .1
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Cumulative whole-disk bytes `(read, write)` from IOKit. The per-physical-disk counters live in
/// the IOBlockStorageDriver node's "Statistics" dict; APFS container/volume nodes carry their own
/// (differently-named) counters deeper in the same subtree, so only Statistics lines owned by an
/// IOBlockStorageDriver class are summed — one entry per physical disk. ~25 ms via `ioreg`.
#[cfg(not(windows))]
fn disk_counters() -> Option<(u64, u64)> {
    let out = std::process::Command::new("ioreg")
        .args(["-rc", "IOBlockStorageDriver", "-l"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Node headers look like "+-o NAME <class IOBlockStorageDriver, id ...>"; a node's properties
    // follow its header until the next one.
    let mut read: u64 = 0;
    let mut write: u64 = 0;
    let mut found = false;
    let mut cls = "";
    for line in text.lines() {
        if let Some(at) = line.find("<class ") {
            cls = line[at + "<class ".len()..].split(',').next().unwrap_or("");
            continue;
        }
        if cls == "IOBlockStorageDriver" && line.contains("\"Statistics\"") {
            read += digits_after(line, "\"Bytes (Read)\"").unwrap_or(0);
            write += digits_after(line, "\"Bytes (Write)\"").unwrap_or(0);
            found = true;
        }
    }
    found.then_some((read, write))
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

/// `nvidia-smi` ships with the driver; look on PATH plus known locations. The answer never
/// changes during a run, so scan once and reuse (callers probe per PID / per poll).
#[cfg(windows)]
static NVIDIA_SMI: std::sync::LazyLock<Option<String>> = std::sync::LazyLock::new(|| {
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
});

#[cfg(windows)]
pub(crate) fn resolve_nvidia_smi() -> Option<String> {
    NVIDIA_SMI.clone()
}

/// No NVIDIA GPUs exist on macOS — skip the (Windows-only) PATH scan every poll.
#[cfg(not(windows))]
pub(crate) fn resolve_nvidia_smi() -> Option<String> {
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
    /// macOS Activity-Monitor-style RAM breakdown (null on Windows or when unavailable).
    pub ram_app_bytes: Option<u64>,
    pub ram_wired_bytes: Option<u64>,
    pub ram_compressed_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
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
    /// Lazily opened PDH rate counters for whole-system disk throughput (Windows only).
    #[cfg(windows)]
    disk_io: Option<DiskIo>,
    /// Previous whole-disk cumulative bytes + when sampled — macOS throughput comes from deltas.
    #[cfg(not(windows))]
    prev_disk: Option<(Instant, u64, u64)>,
}

impl Default for SysStatsCache {
    fn default() -> Self {
        #[cfg(windows)]
        let disk_io = None;
        Self {
            prev_cpu: None,
            cached: None,
            #[cfg(windows)]
            disk_io,
            #[cfg(not(windows))]
            prev_disk: None,
        }
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

    // Fast counter reads — inline on Windows (FFI). On macOS the RAM probe is a bounded
    // `vm_stat` subprocess, so it leaves the runtime thread there.
    let cpu_now = cpu_counters();
    #[cfg(windows)]
    let ram = memory();
    #[cfg(not(windows))]
    let ram = tokio::task::spawn_blocking(memory).await.expect("blocking pool");
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
    #[cfg(windows)]
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
    // Whole-system disk throughput on macOS — cumulative IOKit bytes; the rate is the delta
    // between polls. First sample is baseline only ("—"), a counter rollback (reboot, disk swap)
    // just resets the baseline.
    #[cfg(not(windows))]
    let (disk_read_bps, disk_write_bps): (Option<f64>, Option<f64>) = {
        let now = Instant::now();
        // `ioreg` is a ~25 ms subprocess — keep it off the runtime thread.
        match tokio::task::spawn_blocking(disk_counters).await.expect("blocking pool") {
            Some(curr) => {
                let mut cache = state.sys_stats.lock().await;
                let rates = match cache.prev_disk {
                    // >100 ms window keeps a rapid recheck+poll pair from dividing by ~0.
                    Some((at, pr, pw)) if curr.0 >= pr && curr.1 >= pw => {
                        let secs = at.elapsed().as_secs_f64();
                        (secs > 0.1).then(|| ((curr.0 - pr) as f64 / secs, (curr.1 - pw) as f64 / secs))
                    }
                    _ => None,
                };
                cache.prev_disk = Some((now, curr.0, curr.1));
                match rates {
                    Some((r, w)) => (Some(r), Some(w)),
                    None => (None, None),
                }
            }
            None => (None, None),
        }
    };

    // Slow GPU probe runs outside the lock so it can't stall other polls.
    let gpus = probe_nvidia().await;

    let data = SystemStats {
        sampled_at_ms: now_ms(),
        cpu_percent,
        ram_used_bytes: ram.used,
        ram_total_bytes: ram.total,
        ram_app_bytes: ram.app,
        ram_wired_bytes: ram.wired,
        ram_compressed_bytes: ram.compressed,
        swap_used_bytes: ram.swap_used,
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
