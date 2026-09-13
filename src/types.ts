interface GpuInfo {
  name: string;
  vram_mb: number | null;
}

interface HardwareInfo {
  cpu_name: string;
  ram_gb: number;
  nvidia_gpus: GpuInfo[];
  other_gpus: string[];
}

export interface BuildAsset {
  backend: string; // install key: "cpu" | "cuda-12.4" | "cuda-13.3" | "vulkan" | "sycl"
  label: string; // human-readable, e.g. "CUDA 12.4 (NVIDIA)"
  tag: string; // release tag, e.g. "b7184"
  size_mb: number;
  sha256: string | null; // expected checksum of main archive; null if not published
  recommended: boolean;
}

export interface OnboardingData {
  hardware: HardwareInfo;
  builds: BuildAsset[];
  latest_tag: string;
}

export interface EngineInfo {
  name: string;
  path: string;
  version: string | null; // e.g. "b7184" when installed from a release
}

export interface ServerInfo {
  port: number;
  pid: number;
  model_path: string;
  /** true when re-adopted from a process that outlived the previous app session (no live output) */
  reconnected: boolean;
}

/** HF repo info fetched after download (`GET /api/models/{repo}`) — sparse, keyed by absolute model path in Settings. */
export interface HfModelInfo {
  id: string; // "owner/repo"
  author: string; // publisher
  pipeline_tag?: string | null;
  downloads: number;
  likes: number;
  /** GGUF architecture string (e.g. "nemotron_h") — absent when the repo has no parsed GGUF metadata. */
  gguf_architecture?: string | null;
  /** Total parameter count from the parsed GGUF header, if present. */
  gguf_total_params?: number | null;
}

export interface Settings {
  engine_exe: string | null;
  model_paths: string[];
  /** Optional SearXNG instance base URL (e.g. http://localhost:8081). */
  searxng_url?: string | null;
  /** Absolute models root for HF downloads / local listing. Null = app default. */
  models_dir?: string | null;
  /** Default model preselected in new Quick Launch tabs. Null = empty pick. */
  default_model?: string | null;
  /** Display wall-clock times in 24-hour format. */
  use_24h?: boolean;
  /** Server log retention in days (0 = keep everything); pruned at app start. */
  log_retention_days?: number;
  /** Per-model display aliases keyed by absolute model path (sparse). */
  model_aliases?: Record<string, string>;
  /** HF repo info fetched after download, keyed by absolute model path (sparse). */
  model_meta?: Record<string, HfModelInfo>;
}

type ChatRole = "system" | "user" | "assistant";

/** OpenAI-compatible content part — text or an image (data URL) for mmproj vision models. */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  /** Plain string for normal messages; parts array only when the message carries images. */
  content: string | ChatContentPart[];
}
