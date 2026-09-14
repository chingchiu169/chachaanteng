// Ported from reference ui/js/benchmark-ui.js (pushFlagArg + buildBenchmarkArgs).
// Builds the flat CLI arg list for llama-bench / llama-perplexity. Our app always
// passes absolute local model paths — no models-dir or HF-repo machinery here.

import { FLAGS } from "./definitions";
import type { FlagDef, FlagValues } from "./types";
import { flattenArgs, quoteArg, redactSensitiveTokens, shouldOmitLegacyLoadFlag } from "./core";
import { isMac } from "../lib/platform";

/** Flag ids the benchmark tools actually understand (everything else is excluded).
 *  HF source flags are deliberately absent — they're dropped earlier in buildBenchmarkArgs. */
const BENCH_COMPATIBLE_IDS = new Set([
  "ctx_size",
  "batch_size",
  "ubatch_size",
  "threads",
  "threads_batch",
  "numa",
  "prio",
  "poll",
  "gpu_layers",
  "split_mode",
  "tensor_split",
  "main_gpu",
  "device",
  "flash_attn",
  "load_mode",
  "mmap",
  "direct_io",
  "fit",
  "fit_target",
  "fit_ctx",
  "cache_type_k",
  "cache_type_v",
]);

interface BenchApplied {
  label: string;
  value: string;
}

interface BenchExcluded {
  label: string;
  reason: string;
}

interface BenchBuildOptions {
  /** Absolute GGUF path (already resolved from the selected source). */
  model: string;
  benchmarkType: "bench" | "perplexity";
  /** Source flag values — current Configure state or a loaded preset. */
  flags?: FlagValues;
  /** Defaults, used only to keep the excluded-report quiet for untouched values. */
  defaultFlags?: FlagValues;
  // bench (throughput) controls
  repetitions?: number;
  nPrompt?: number;
  nGen?: number;
  outputFormat?: string; // md | json | csv
  // perplexity controls
  pplCleanRun?: boolean;
  pplContextSize?: number;
  pplBatchSize?: number;
  pplUbatchSize?: number;
  pplThreads?: number;
  pplGpuLayers?: string;
  pplFlashAttention?: string;
  pplCacheTypeK?: string;
  pplCacheTypeV?: string;
  pplMmap?: boolean;
  chunks?: string;
  pplStride?: string;
  warmup?: boolean;
  /** Absolute path to the prompt/data file (e.g. wiki.test.raw). */
  promptFile?: string;
}

interface BenchBuildResult {
  tool: "llama-bench" | "llama-perplexity";
  /** Flat, ready for bench_start(). */
  args: string[];
  applied: BenchApplied[];
  excluded: BenchExcluded[];
  error: string | null;
  /** Quoted preview line (sensitive tokens redacted). */
  command: string;
}

function isEmptyFlagValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
  }
  return String(left) === String(right);
}

/** Push one flag's value onto the llama-bench arg list; returns true when something was added. */
function pushFlagArg(args: (string | string[])[], flag: FlagDef, value: unknown): boolean {
  if (isEmptyFlagValue(value)) return false;

  // llama-bench-specific handling
  if (flag.id === "ctx_size") return false; // bench sizes its own context per run
  if (flag.id === "threads" && String(value).trim() === "-1") return false;
  if (flag.id === "gpu_layers") {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "auto" || normalized === "all") return false; // bench auto-detects
  }
  if (flag.id === "mmap") {
    args.push(["-mmp", value ? "1" : "0"]);
    return true;
  }
  if (flag.id === "direct_io") {
    args.push(["-dio", value ? "1" : "0"]);
    return true;
  }
  if (flag.id === "fit") return false; // not a bench concept

  if (flag.type === "bool") {
    if (value === true && flag.flag) {
      args.push([flag.flag]);
      return true;
    }
    if (value === false && flag.false_flag) {
      args.push([flag.false_flag]);
      return true;
    }
    return false;
  }

  if (flag.type === "multi_enum") {
    const values = Array.isArray(value) ? value.filter(Boolean).map(String) : [];
    if (values.length === 0) return false;
    args.push([flag.flag, values.join(",")]);
    return true;
  }

  if (flag.type === "text_list") {
    const items = Array.isArray(value) ? value : String(value).split(/\r?\n/);
    let added = false;
    for (const item of items) {
      const normalized = String(item).trim();
      if (!normalized) continue;
      args.push([flag.flag, normalized]);
      added = true;
    }
    return added;
  }

  // llama-bench uses commas between independent runs and slashes within one GPU group.
  const cliValue =
    flag.id === "tensor_split" || flag.id === "device"
      ? String(value)
          .split(",")
          .map((p) => p.trim())
          .join("/")
      : String(value);
  args.push([flag.flag, cliValue]);
  return true;
}

export function buildBenchmarkArgs(options: BenchBuildOptions): BenchBuildResult {
  const benchmarkType = options.benchmarkType === "perplexity" ? "perplexity" : "bench";
  const tool: "llama-bench" | "llama-perplexity" =
    benchmarkType === "perplexity" ? "llama-perplexity" : "llama-bench";
  const flags: FlagValues = options.flags && typeof options.flags === "object" ? { ...options.flags } : {};
  const defaultFlags: FlagValues = options.defaultFlags || {};
  const model = String(options.model || "").trim();

  /** True when a flag is set to something other than its default — worth reporting as excluded. */
  const isNonDefault = (id: string) =>
    !Object.prototype.hasOwnProperty.call(defaultFlags, id) || !valuesEqual(flags[id], defaultFlags[id]);

  const args: (string | string[])[] = [];
  const applied: BenchApplied[] = [];
  const excluded: BenchExcluded[] = [];

  if (!model) {
    return { tool, args: [], applied, excluded, error: "Select a model before running a benchmark.", command: "" };
  }
  args.push(["-m", model]);
  applied.push({ label: "Model", value: model.split(/[\\/]/).pop() || model });

  if (benchmarkType === "bench") {
    for (const flag of FLAGS) {
      const value = flags[flag.id];
      if (isEmptyFlagValue(value)) continue;
      // HF source flags are not part of our local-path flow — never pass them through.
      if (flag.id === "hf_repo" || flag.id === "hf_file" || flag.id === "hf_token") {
        excluded.push({ label: flag.label, reason: "Benchmarks use the selected local model" });
        continue;
      }
      if (!BENCH_COMPATIBLE_IDS.has(flag.id)) {
        if (isNonDefault(flag.id)) {
          excluded.push({ label: flag.label, reason: "Not used by benchmark tools" });
        }
        continue;
      }
      if (shouldOmitLegacyLoadFlag(flag, flags)) continue;

      if (flag.id === "threads_batch") {
        if (isNonDefault(flag.id)) {
          excluded.push({ label: flag.label, reason: "llama-bench uses one thread setting" });
        }
        continue;
      }

      const before = args.length;
      const didApply = pushFlagArg(args, flag, value);
      if (didApply && args.length > before) {
        applied.push({
          label: flag.label,
          value: flag.sensitive ? "<redacted>" : Array.isArray(value) ? value.join(",") : String(value),
        });
      } else if (isNonDefault(flag.id)) {
        excluded.push({ label: flag.label, reason: "Not supported for this benchmark" });
      }
    }

    const repetitions = options.repetitions ?? 5;
    const nPrompt = options.nPrompt ?? 512;
    const nGen = options.nGen ?? 128;
    const outputFormat = options.outputFormat || "md";
    args.push(["-r", String(repetitions)]);
    args.push(["-p", String(nPrompt)]);
    args.push(["-n", String(nGen)]);
    args.push(["-o", outputFormat]);
    applied.push({ label: "Repetitions", value: String(repetitions) });
    applied.push({ label: "Prompt Tokens", value: String(nPrompt) });
    applied.push({ label: "Generation Tokens", value: String(nGen) });
    applied.push({ label: "Output Format", value: outputFormat });
  } else {
    const cleanRun = options.pplCleanRun === true;
    if (!options.promptFile || !String(options.promptFile).trim()) {
      return { tool, args: [], applied, excluded, error: "Choose a prompt/data file before running perplexity.", command: "" };
    }
    const contextSize = options.pplContextSize ?? 4096;
    const batchSize = options.pplBatchSize ?? 2048;
    const ubatchSize = options.pplUbatchSize ?? 512;
    const threads = options.pplThreads ?? -1;
    const gpuLayers = String(options.pplGpuLayers || "auto").trim();
    const flashAttention = options.pplFlashAttention || "auto";
    const cacheTypeK = options.pplCacheTypeK || "f16";
    const cacheTypeV = options.pplCacheTypeV || "f16";

    if (cleanRun) {
      args.push(["-f", String(options.promptFile)]);
      applied.push({ label: "Mode", value: "llama.cpp clean run" });
      excluded.push({ label: "Perplexity Controls", reason: "Clean run only passes model and prompt/data file" });
    } else {
      args.push(["-c", String(contextSize)]);
      args.push(["-b", String(batchSize)]);
      args.push(["-ub", String(ubatchSize)]);
      args.push(["-t", String(threads)]);
      if (gpuLayers) args.push(["-ngl", gpuLayers]);
      if (flashAttention) args.push(["-fa", flashAttention]);
      if (cacheTypeK) args.push(["-ctk", cacheTypeK]);
      if (cacheTypeV) args.push(["-ctv", cacheTypeV]);
      if (options.pplMmap === false) args.push(["--no-mmap"]);
      args.push(["-f", String(options.promptFile)]);
      if (options.chunks !== undefined && options.chunks !== "") args.push(["--chunks", String(options.chunks)]);
      if (options.pplStride !== undefined && options.pplStride !== "") args.push(["--ppl-stride", String(options.pplStride)]);
      args.push([options.warmup === false ? "--no-warmup" : "--warmup"]);
      applied.push({ label: "Context Size", value: String(contextSize) });
      applied.push({ label: "Batch Size", value: String(batchSize) });
      applied.push({ label: "Micro Batch Size", value: String(ubatchSize) });
      applied.push({ label: "Threads", value: String(threads) });
      if (gpuLayers) applied.push({ label: "GPU Layers", value: gpuLayers });
      if (flashAttention) applied.push({ label: "Flash Attention", value: flashAttention });
      if (cacheTypeK) applied.push({ label: "K Cache Type", value: cacheTypeK });
      if (cacheTypeV) applied.push({ label: "V Cache Type", value: cacheTypeV });
      applied.push({ label: "Memory Mapping", value: options.pplMmap === false ? "Off (--no-mmap)" : "On" });
      applied.push({ label: "Chunks", value: options.chunks === undefined || options.chunks === "" ? "-1" : String(options.chunks) });
      applied.push({ label: "PPL Stride", value: options.pplStride === undefined || options.pplStride === "" ? "0" : String(options.pplStride) });
      applied.push({ label: "Warmup", value: options.warmup === false ? "Off" : "On" });
    }
    applied.push({ label: "Prompt/Data File", value: String(options.promptFile).split(/[\\/]/).pop() || String(options.promptFile) });
    if (Object.keys(flags).length > 0 && !cleanRun) {
      excluded.push({ label: "Configure/Preset Flags", reason: "Perplexity uses only the settings shown here" });
    }
  }

  const flat = flattenArgs(args);
  const command = [isMac() ? tool : `${tool}.exe`, ...redactSensitiveTokens(flat)].map(quoteArg).join(" ");
  return { tool, args: flat, applied, excluded, error: null, command };
}

interface BenchTs {
  /** token-generation (tg) t/s — the chat typing speed */
  tg: number[];
  /** prompt-processing (pp) t/s — prefill speed */
  pp: number[];
}

/** Extract throughput figures from benchmark output. llama-bench reports both prompt
 *  processing (ppN) and token generation (tgN); the UI shows tg only, since that's the
 *  speed you actually feel in chat. Handles md table / csv / json + legacy "N t/s" lines. */
export function extractBenchTs(output: string): BenchTs {
  const res: BenchTs = { tg: [], pp: [] };
  const push = (bucket: "tg" | "pp", n: number) => {
    if (Number.isFinite(n) && n > 0) res[bucket].push(n);
  };

  // md table rows: ... | test | t/s | — the test cell ("pp512"/"tg128") sits second-to-last,
  // and on b10xxx+ builds the value cell is a bare "16393.46 ± 1146.70" (unit only in header).
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const value = cells[cells.length - 1].match(/^([\d.]+)\s*(?:±\s*[\d.]+\s*)?$/);
    if (!value) continue; // header / separator row
    push(/^pp/i.test(cells[cells.length - 2] ?? "") ? "pp" : "tg", Number(value[1]));
  }

  // csv: locate the n_gen column from the header, take avg_ts (second-to-last field).
  {
    const lines = output.split(/\r?\n/);
    const headerIdx = lines.findIndex((l) => l.includes("avg_ts"));
    if (headerIdx >= 0) {
      const genCol = lines[headerIdx].split(",").indexOf("n_gen");
      for (const line of lines.slice(headerIdx + 1)) {
        const m = line.match(/"([\d.]+)","[\d.]+"\s*$/); // avg_ts,"stddev_ts"
        if (!m) continue;
        const isGen = genCol < 0 || (line.split(",")[genCol] ?? "").replace(/"/g, "") !== "0";
        push(isGen ? "tg" : "pp", Number(m[1]));
      }
    }
  }

  // json: each result object carries n_gen + avg_ts (fixed field order from serde).
  for (const m of output.matchAll(/"n_gen"\s*:\s*(\d+)[\s\S]*?"avg_ts"\s*:\s*([\d.]+)/g)) {
    push(Number(m[1]) > 0 ? "tg" : "pp", Number(m[2]));
  }

  // legacy / unlabeled "N t/s": bucket by a pp/tg label on the same line, default tg.
  for (const m of output.matchAll(/([\d.]+)\s*(?:±\s*[\d.]+\s*)?t\/s/gi)) {
    const start = output.lastIndexOf("\n", m.index ?? 0) + 1;
    const endIdx = output.indexOf("\n", (m.index ?? 0) + m[0].length);
    const line = output.slice(start, endIdx === -1 ? undefined : endIdx);
    push(/(^|[^a-z])pp\d/i.test(line) ? "pp" : "tg", Number(m[1]));
  }

  return res;
}

/** Extract the final perplexity estimate ("Final estimate: PPL = X +/- Y"), if present. */
export function extractPpl(output: string): number | null {
  const m = output.match(/Final estimate:\s*PPL\s*=\s*([\d.]+)/i);
  return m ? Number(m[1]) : null;
}
