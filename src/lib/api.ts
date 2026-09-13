import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  EngineInfo,
  HfModelInfo,
  OnboardingData,
  ServerInfo,
  Settings,
} from "../types";

export const getOnboardingData = () => invoke<OnboardingData>("get_onboarding_data");

export const installBuild = (tag: string, backend: string) =>
  invoke<string>("install_build", { tag, backend });

export const validateCustomEngine = (path: string) =>
  invoke<{ ok: boolean; version: string | null; path: string }>("validate_custom_engine", { path });

export const listInstalledEngines = () => invoke<EngineInfo[]>("list_installed_engines");

export const deleteInstalledEngine = (path: string) =>
  invoke<void>("delete_installed_engine", { path });

export interface EngineVersion {
  tag: string;
}

export const listEngineVersions = () => invoke<EngineVersion[]>("list_engine_versions");

/// Launch with a fully-built flag argument list (Quick Launch / Configure).
/// `args` must already contain `-m <model>`; host/port are appended by Rust.
export const launchServer = (engineExe: string, args: string[], port: number) =>
  invoke<ServerInfo>("launch_server", { engineExe, args, port });

interface MemoryEstimateRow {
  kind: "ram" | "accelerator";
  device: string;
  model_mib: number;
  context_mib: number;
  compute_mib: number;
}

export interface MemoryEstimate {
  ok: boolean;
  error?: string;
  rows: MemoryEstimateRow[];
  total_model_mib: number;
  total_context_mib: number;
  total_compute_mib: number;
}

/// Run llama-fit-params -fitp on the engine to estimate memory usage.
export const estimateMemory = (engineExe: string, args: string[]) =>
  invoke<MemoryEstimate>("estimate_memory", { engineExe, args });

export const stopServer = (port: number) => invoke<void>("stop_server", { port });

export const listServers = () => invoke<ServerInfo[]>("list_servers");

/// Buffered log lines for a running server (Rust-side ring buffer, newest last).
export const getServerLogs = (port: number) => invoke<string[]>("get_server_logs", { port });

export interface ServerLogFile {
  name: string;
  size_bytes: number;
  modified_ms: number;
}

/// Persisted server log files on disk, newest first.
export const listServerLogs = () => invoke<ServerLogFile[]>("list_server_logs");

/// Read a persisted server log file (tail-capped at ~256 KB).
export const readServerLog = (name: string) => invoke<string>("read_server_log", { name });

/// Delete a persisted server log file.
export const deleteServerLog = (name: string) => invoke<void>("delete_server_log", { name });

// --- presets (FR3) ----------------------------------------------------------

export interface PresetInfo {
  name: string;
  data: Record<string, unknown>;
  created_ms: number;
  modified_ms: number;
  archived: boolean;
}

export const listPresets = () => invoke<PresetInfo[]>("list_presets");

export const savePreset = (name: string, data: unknown, overwrite = true) =>
  invoke<string>("save_preset", { name, data, overwrite });

export const renamePreset = (name: string, newName: string) =>
  invoke<string>("rename_preset", { name, newName });

export const deletePreset = (name: string) => invoke<void>("delete_preset", { name });

export const archivePresets = (names: string[], archived: boolean) =>
  invoke<void>("archive_presets", { names, archived });

// --- models & HF download (FR4) ---------------------------------------------

export interface HfFile {
  name: string;
  size: number | null;
  shard_count?: number;
}

export interface HfRepoFiles {
  repo_id: string;
  revision: string;
  models: HfFile[];
  mmproj: HfFile[];
}

export const hfListRepoFiles = (repoId: string, revision: string) =>
  invoke<HfRepoFiles>("hf_list_repo_files", { repoId, revision });

export interface HfModelHit {
  id: string;
  downloads: number;
}

export const hfSearchModels = (query: string, ggufOnly: boolean) =>
  invoke<HfModelHit[]>("hf_search_models", { query, ggufOnly });

/// Single-repo info from `GET /api/models/{repo}` — used to enrich a model's list row after download.
export const hfModelInfo = (repoId: string) => invoke<HfModelInfo>("hf_model_info", { repoId });

export interface HfDownloadState {
  status: "idle" | "starting" | "downloading" | "cancelling" | "done" | "error" | "cancelled";
  message: string;
  /** Original repo id (e.g. "unsloth/Qwen3.5-2B-GGUF") — set at start, present on the done event too. */
  repo_id: string;
  total: number;
  downloaded: number;
  current_file: string;
  model_path: string;
}

export const hfStartDownload = (
  repoId: string,
  revision: string,
  modelFile: string,
  mmprojFile: string | null,
  overwrite = false,
) =>
  invoke<HfDownloadState>("hf_start_download", {
    repoId,
    revision,
    modelFile,
    mmprojFile,
    overwrite,
  });

export const hfCancelDownload = () => invoke<HfDownloadState>("hf_cancel_download");

export const hfGetDownloadStatus = () => invoke<HfDownloadState>("hf_get_download_status");

export interface ModelsDirInfo {
  models_dir: string;
}

export const getModelsDirInfo = () => invoke<ModelsDirInfo>("get_models_dir_info");

export interface LocalModelFile {
  rel_path: string;
  size_bytes: number;
}

export const listLocalModels = (root?: string) =>
  invoke<LocalModelFile[]>("list_local_models", { root });

/// Delete a local GGUF file under the models root (rel_path with forward slashes).
export const deleteLocalModel = (root: string, relPath: string) =>
  invoke<void>("delete_local_model", { root, relPath });

/// Delete a GGUF file by absolute path (user-imported model cleanup).
export const deleteModelFile = (path: string) =>
  invoke<void>("delete_model_file", { path });

/// Write a UTF-8 text file to an absolute path (preset .cmd export).
export const writeTextFile = (path: string, contents: string) =>
  invoke<void>("write_text_file", { path, contents });

export const serverHealth = (port: number, host?: string) => invoke<boolean>("server_health", { port, host });

// --- external server registration (FR8.3) ------------------------------------

export interface ExternalTarget {
  host: string;
  port: number;
  label: string;
}

interface RememberedExternalTarget extends ExternalTarget {
  api_key_required: boolean;
}

interface ExternalState {
  connected: ExternalTarget | null;
  remembered: RememberedExternalTarget | null;
}

interface ExternalConnectResult {
  target: ExternalTarget;
  warning: string;
}

/** Register an externally started llama-server as the chat target. Probes /health first. */
export const externalConnect = (host: string, port: number, apiKey: string, label: string) =>
  invoke<ExternalConnectResult>("external_connect", { host, port, apiKey, label });

/** Forget the registered server + drop the remembered address. */
export const externalDisconnect = () => invoke<void>("external_disconnect");

/** Current registration + remembered address (form prefill). */
export const externalGet = () => invoke<ExternalState>("external_get");

/** Re-register the saved address on app start (uses the OS-stored key when one was needed; null when not restorable). */
export const externalRestore = () => invoke<ExternalTarget | null>("external_restore");

/** Store/replace an address's API key in the OS credential store without connecting; empty key clears it. */
export const externalStoreKey = (host: string, port: number, key: string) =>
  invoke<void>("external_store_key", { host, port, key });

/** Whether an API key is stored for this address in the OS credential store. */
export const externalHasKey = (host: string, port: number) => invoke<boolean>("external_has_key", { host, port });

// ── FR8.1 — Cloudflare quick tunnel ────────────────────────────────

export interface TunnelSnapshot {
  /** idle | preparing | downloading | starting | running | stopped | error */
  status: string;
  url: string;
  message: string;
  log: string[];
}

/** Current tunnel state (the UI polls this every ~2s while active). */
export const tunnelStatus = () => invoke<TunnelSnapshot>("tunnel_status");

/** Start a quick tunnel exposing http://127.0.0.1:<port> (downloads cloudflared on first use). */
export const tunnelStart = (port: number) => invoke<TunnelSnapshot>("tunnel_start", { port });

/** Stop the tunnel and kill cloudflared. */
export const tunnelStop = () => invoke<TunnelSnapshot>("tunnel_stop");

// ── FR8.2 — Git auto-update (dev installs only) ────────────────────

export interface GitStatus {
  branch: string;
  /** "abc1234 subject line" of HEAD */
  head: string;
  ahead: number;
  behind: number;
  dirty: string[];
  /** set when `git fetch` failed — behind/ahead may be stale */
  fetch_note?: string | null;
}

export interface GitPullResult {
  head: string;
  stashed: boolean;
}

/** Fetch + report branch/HEAD/behind-ahead/dirty paths. Errors when not a git install. */
export const gitUpdateStatus = () => invoke<GitStatus>("git_update_status");

/** Auto-stash uncommitted work, `git pull --ff-only`, report the new HEAD. */
export const gitPull = () => invoke<GitPullResult>("git_pull");

/** Relaunch the app (new code) and exit the current process. */
export const restartApp = () => invoke<void>("restart_app");

interface ChatParams {
  /** Sampling overrides — omit to let the server's launch-time settings apply. */
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** Per-request chat template override (llama.cpp built-in name). */
  chat_template?: string;
  /** Per-request template kwargs, e.g. { enable_thinking: false }. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat_template_kwargs?: any;
  /** Thinking-model effort (b10864+): "low" | "medium" | "high". Passed to the model's Jinja template. */
  reasoning_effort?: string;
}

// --- web search (FR2.4) -------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  ok: boolean;
  query: string;
  results: SearchResult[];
  error?: string;
}

/// SearXNG (if configured in Settings) with DuckDuckGo fallback.
export const webSearch = (query: string, maxResults?: number) =>
  invoke<SearchResponse>("web_search", { query, maxResults });

/// Open a URL in the default browser (http/https only).
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/// One streamed token from chat_stream. `kind` is "content" or "reasoning".
export interface StreamToken {
  kind: "content" | "reasoning";
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const chatStream = (
  port: number,
  host: string,
  messages: ChatMessage[],
  params: ChatParams,
  onToken: any,
) => invoke<void>("chat_stream", { port, host, messages, params, onToken });

export const stopChat = () => invoke<void>("stop_chat");

/// A file attached from the composer's attachment button. kind "image" → `data` is a base64
/// data URL (sent as an image_url part); "text" → `data` is the file content to append.
export interface AttachmentData {
  name: string;
  kind: "image" | "text";
  data: string;
}

export const readAttachment = (path: string) => invoke<AttachmentData>("read_attachment", { path });

/// Live context capacity (min n_ctx across server slots).
export const contextCapacity = (port: number, host: string) =>
  invoke<number>("context_capacity", { port, host });

/// Exact prompt token count for a message list (server renders the template; costs 1 decode step).
export const measurePromptTokens = (port: number, host: string, messages: ChatMessage[]) =>
  invoke<number>("measure_prompt_tokens", { port, host, messages });

/// Fast approximate token count via the server tokenizer (no template rendering).
export const tokenizeCount = (port: number, host: string, text: string) =>
  invoke<number>("tokenize_count", { port, host, text });

export const getSettings = () => invoke<Settings>("get_settings");

export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });

// --- flag scopes (Phase G): global base + per-model overrides ---------------

/** Sparse map of flag id → value; only non-default entries are stored. */
type FlagScopeValues = Record<string, unknown>;

export const getFlagValues = () => invoke<FlagScopeValues>("get_flag_values");

export const saveFlagValues = (values: FlagScopeValues) =>
  invoke<void>("save_flag_values", { values });

/** `{ [modelPath]: { flagId: value } }` — sparse per-model overrides. */
type ModelOverrides = Record<string, FlagScopeValues>;

export const getModelOverrides = () => invoke<ModelOverrides>("get_model_overrides");

/** Persist one model's override map; an empty object deletes the entry. */
export const setModelOverride = (modelPath: string, overrides: FlagScopeValues) =>
  invoke<void>("set_model_override", { modelPath, overrides });

// --- conversations (FR2.5) -------------------------------------------------

export interface ConversationMeta {
  id: number;
  title: string;
  model_path: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  created_at: number;
}

interface StoredMessage {
  id: number;
  conv_id: number;
  role: string;
  content: string;
  created_at: number;
}

export const listConversations = () => invoke<ConversationMeta[]>("list_conversations");

export const getMessages = (convId: number) => invoke<StoredMessage[]>("get_messages", { convId });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const saveConversation = (id: number, title: string, modelPath: string | null, params: any) =>
  invoke<number>("save_conversation", { id, title, modelPath, params });

export const appendMessage = (convId: number, role: string, content: string) =>
  invoke<void>("append_message", { convId, role, content });

export const renameConversation = (id: number, title: string) =>
  invoke<void>("rename_conversation", { id, title });

export const deleteConversation = (id: number) => invoke<void>("delete_conversation", { id });

// --- benchmarks (FR5) --------------------------------------------------------

export interface BenchStatus {
  tool: "llama-bench" | "llama-perplexity";
  pid: number;
  started_at_ms: number;
}

/// Spawn a benchmark tool (sibling of the engine exe). `args` is the full flag list.
export const benchStart = (engineExe: string, tool: string, args: string[]) =>
  invoke<BenchStatus>("bench_start", { engineExe, tool, args });

export const benchStop = () => invoke<void>("bench_stop");

/// Currently running benchmark, if any.
export const benchStatus = () => invoke<BenchStatus | null>("bench_status");

/// Ring-buffered output lines (newest last) — restores the terminal after a tab switch.
export const getBenchLogs = () => invoke<string[]>("get_bench_logs");

interface WikitextResult {
  ready: boolean;
  downloaded: boolean;
  path: string;
}

/// Ensure WikiText-2 test set exists under the models dir (downloads + extracts on demand).
export const ensureWikitext2 = () => invoke<WikitextResult>("ensure_wikitext2");

// --- monitor / system stats (FR6) ---------------------------------------------

interface GpuStats {
  name: string;
  utilization_percent: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  temperature_c: number | null;
  power_watts: number | null;
}

export interface SystemStats {
  sampled_at_ms: number;
  cpu_percent: number | null;
  ram_used_bytes: number;
  ram_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  /** Whole-system disk throughput from PDH counters (null until the first valid sample). */
  disk_read_bps: number | null;
  disk_write_bps: number | null;
  gpus: GpuStats[];
}

/// CPU/RAM/disk + GPU telemetry, served from a 2s cache unless `refresh`.
export const getSystemStats = (refresh = false) =>
  invoke<SystemStats>("get_system_stats", { refresh });

// --- live server metrics proxy (FR6.3) -----------------------------------------

/// Raw Prometheus text from the running server's /metrics endpoint.
export const serverMetrics = (port: number) => invoke<string>("server_metrics", { port });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerJsonValue = any;

/// Slot table from the server's /slots endpoint.
export const serverSlots = (port: number) => invoke<ServerJsonValue>("server_slots", { port });

/// Build/runtime properties from the server's /props endpoint.
export const serverProps = (port: number) => invoke<ServerJsonValue>("server_props", { port });

// --- per-server process telemetry (Rust-side FFI, no HTTP) ---------------------

export interface ServerProcessStats {
  /** CPU busy % across all logical processors; null on the first sample. */
  cpu_percent: number | null;
  /** Working-set RAM in bytes; 0 when it can't be read. */
  ram_bytes: number;
  /** Per-process GPU SM utilization % (nvidia-smi pmon); null without NVIDIA / not a compute app. */
  gpu_util_percent: number | null;
  /** Per-process VRAM in bytes; null without NVIDIA / not a compute app. */
  gpu_mem_bytes: number | null;
}

/// CPU/RAM + per-PID GPU utilization/VRAM for one registered server port.
export const serverProcessStats = (port: number) =>
  invoke<ServerProcessStats>("server_process_stats", { port });
