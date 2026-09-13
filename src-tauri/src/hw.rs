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

#[derive(serde::Deserialize)]
struct PsGpu {
    #[serde(rename = "Name")]
    name: String,
}

#[derive(serde::Deserialize)]
struct PsOut {
    gpus: Vec<PsGpu>,
    cpu: String,
    #[serde(rename = "ramGb")]
    ram_gb: u64,
}

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
