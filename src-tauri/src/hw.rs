use serde::Serialize;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

/// nvidia-smi / CIM probes must never hang the onboarding screen — hard cap each one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub vram_mb: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct HardwareInfo {
    pub arch: String,
    pub cpu_name: String,
    pub ram_gb: u64,
    pub nvidia_gpus: Vec<GpuInfo>,
    /// Non-NVIDIA GPUs (AMD / Intel Arc etc.) — Vulkan candidates
    pub other_gpus: Vec<String>,
    /// True if a non-Microsoft discrete GPU exists besides NVIDIA ones
    pub has_other_discrete: bool,
}

async fn detect_nvidia() -> Vec<GpuInfo> {
    let mut cmd = Command::new("nvidia-smi");
    crate::util::hide_console_tokio(&mut cmd);
    cmd.args([
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ])
    .kill_on_drop(true); // timeout below drops the command — kill the child with it
    let out = match timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() >= 2 {
                Some(GpuInfo {
                    name: parts[0].to_string(),
                    vram_mb: parts[1].parse().ok(),
                })
            } else {
                None
            }
        })
        .collect()
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
struct PsGpu {
    #[serde(rename = "Name")]
    name: String,
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
struct PsOut {
    gpus: Vec<PsGpu>,
    cpu: String,
    #[serde(rename = "ramGb")]
    ram_gb: u64,
}

#[cfg(windows)]
async fn detect_system(nvidia_names: &[String]) -> (Vec<String>, bool, String, u64) {
    let ps = r#"@{
      gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name)
      cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
      ramGb = [double][math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 0)
    } | ConvertTo-Json -Compress -Depth 4"#;
    let mut cmd = Command::new("powershell");
    crate::util::hide_console_tokio(&mut cmd);
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps])
        .kill_on_drop(true); // timeout below drops the command — kill the child with it
    let out = match timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return (Vec::new(), false, String::from("Unknown CPU"), 0),
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    match serde_json::from_str::<PsOut>(&text) {
        Ok(p) => {
            // "Microsoft Basic Render Driver" (VMs/headless boxes) is a placeholder, not a
            // GPU — drop it from the list entirely so it doesn't show up as a phantom entry.
            let is_placeholder = |n: &str| {
                let l = n.to_lowercase();
                l.contains("microsoft") || l.contains("basic render")
            };
            let others: Vec<String> = p
                .gpus
                .into_iter()
                .filter(|g| !nvidia_names.contains(&g.name.to_lowercase()))
                .filter(|g| !is_placeholder(&g.name))
                .map(|g| g.name)
                .collect();
            let has_discrete = !others.is_empty();
            (others, has_discrete, p.cpu, p.ram_gb)
        }
        Err(_) => (Vec::new(), false, String::from("Unknown CPU"), 0),
    }
}

/// Run a short CLI probe and return its trimmed stdout (None on any failure/timeout).
#[cfg(not(windows))]
async fn probe_stdout(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    crate::util::hide_console_tokio(&mut cmd);
    cmd.args(args).kill_on_drop(true); // timeout below drops the command — kill the child with it
    match timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        _ => None,
    }
}

#[cfg(not(windows))]
async fn detect_system(_nvidia_names: &[String]) -> (Vec<String>, bool, String, u64) {
    // RAM — fast sysctl.
    let ram_gb = probe_stdout("sysctl", &["-n", "hw.memsize"])
        .await
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| b.div_ceil(1024 * 1024 * 1024))
        .unwrap_or(0);

    // CPU name — system_profiler is the only source of a friendly name on arm64 (machdep.cpu.brand_string
    // does not exist on Apple Silicon). It can take several seconds cold, so it gets the same cap as every
    // other probe; fallback chain: hw.model → generic label.
    let mut cpu_name = probe_stdout("system_profiler", &["SPHardwareDataType"])
        .await
        .and_then(|out| {
            out.lines()
                .find_map(|l| l.trim().strip_prefix("Chip:"))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();
    if cpu_name.is_empty() {
        cpu_name = probe_stdout("sysctl", &["-n", "hw.model"]).await.unwrap_or_default();
    }
    if cpu_name.is_empty() {
        cpu_name = "Apple Silicon".to_string();
    }

    // GPUs intentionally empty — the Monitor GPU tiles are hidden on macOS, and recommend_for() only
    // needs nvidia/has_other_discrete for Windows backends.
    (Vec::new(), false, cpu_name, ram_gb)
}

pub async fn detect() -> HardwareInfo {
    // nvidia-smi runs exactly once — its names are reused to filter the CIM list.
    let nvidia_gpus = detect_nvidia().await;
    let nvidia_names: Vec<String> = nvidia_gpus.iter().map(|g| g.name.to_lowercase()).collect();
    let (other_gpus, has_other_discrete, cpu_name, ram_gb) = detect_system(&nvidia_names).await;
    HardwareInfo {
        arch: std::env::consts::ARCH.to_string(),
        cpu_name,
        ram_gb,
        nvidia_gpus,
        other_gpus,
        has_other_discrete,
    }
}
