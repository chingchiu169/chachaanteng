// Ported from reference ui/js/flag-core.js + ui/js/flags/helpers.js.
// The reference uses a configure()-injected module singleton; here the same rules
// are plain pure functions — state (tool/model/values) lives in the Zustand store.

import { FLAGS } from "./definitions";
import type { FlagDef, FlagValues } from "./types";

export type Tool = "llama-server" | "llama-cli";

/** A launch arg: a bare flag ("--verbose") or [flag, value] pair. */
type LaunchArg = string | [string, string];

interface LaunchArgsResult {
  args: LaunchArg[];
  error: string | null;
  warnings: string[];
}

const DRAFT_SPECULATIVE_TYPES = new Set([
  "draft-simple",
  "draft-eagle3",
  "draft-dflash",
  "draft-dspark",
  "draft-mtp",
]);

export function cloneFlagValue(value: unknown): unknown {
  return Array.isArray(value) ? [...(value as unknown[])] : value;
}

/** Flatten mixed flag entries ("--x" | ["-m", path]) into plain CLI tokens. */
export function flattenArgs(args: (string | string[])[]): string[] {
  return args.flatMap((entry) => (Array.isArray(entry) ? entry.map(String) : [String(entry)]));
}

/** Defaults straight from the definitions (arrays cloned). */
export function getDefaultValues(): FlagValues {
  const defaults: FlagValues = {};
  for (const f of FLAGS) {
    if (f.default !== undefined) {
      defaults[f.id] = Array.isArray(f.default) ? [...(f.default as unknown[])] : f.default;
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Speculative decoding helpers
// ---------------------------------------------------------------------------

function getSpeculativeTypeParts(values: FlagValues): string[] {
  const raw = String((values || {}).spec_type || "none").trim();
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

function isNgramModValue(value: unknown): boolean {
  return value === true || String(value ?? "").trim() === "ngram-mod";
}

function isNgramModEnabled(values: FlagValues): boolean {
  const cfg = values || {};
  const explicit = cfg.ngram_mod !== undefined ? cfg.ngram_mod : cfg.spec_ngram_mod;
  return isNgramModValue(explicit) || getSpeculativeTypeParts(cfg).includes("ngram-mod");
}

function isNgramMapK4vValue(value: unknown): boolean {
  return value === true || String(value ?? "").trim() === "ngram-map-k4v";
}

function isNgramMapK4vEnabled(values: FlagValues): boolean {
  const cfg = values || {};
  const explicit = cfg.ngram_map_k4v !== undefined ? cfg.ngram_map_k4v : cfg.spec_ngram_map_k4v;
  return isNgramMapK4vValue(explicit) || getSpeculativeTypeParts(cfg).includes("ngram-map-k4v");
}

function hasDraftModelSpeculation(values: FlagValues): boolean {
  const cfg = values || {};
  if (cfg.model_draft || cfg.hf_repo_draft) return true;
  return getSpeculativeTypeParts(cfg).some((type) => DRAFT_SPECULATIVE_TYPES.has(type));
}

function isSpeculativeDecodingEnabled(values: FlagValues): boolean {
  const cfg = values || {};
  const specTypes = getSpeculativeTypeParts(cfg);
  return Boolean(
    cfg.model_draft ||
      cfg.hf_repo_draft ||
      specTypes.some((type) => type !== "none") ||
      isNgramModEnabled(cfg) ||
      isNgramMapK4vEnabled(cfg),
  );
}

function getCombinedSpeculativeType(values: FlagValues): string {
  const specTypes = getSpeculativeTypeParts(values);
  const draftType = specTypes.find((type) => DRAFT_SPECULATIVE_TYPES.has(type));
  return [
    draftType,
    isNgramModEnabled(values) ? "ngram-mod" : "",
    isNgramMapK4vEnabled(values) ? "ngram-map-k4v" : "",
  ]
    .filter(Boolean)
    .join(",");
}

/** Legacy presets stored ngram-* inside spec_type; migrate them to the independent flags. */
function normalizeSpeculativeFlagValues(values: FlagValues): FlagValues {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const normalized: FlagValues = { ...source };
  const specTypes = getSpeculativeTypeParts(source);

  const hasExplicitNgram =
    Object.prototype.hasOwnProperty.call(source, "ngram_mod") ||
    Object.prototype.hasOwnProperty.call(source, "spec_ngram_mod");
  if (hasExplicitNgram) {
    const explicit = Object.prototype.hasOwnProperty.call(source, "ngram_mod")
      ? source.ngram_mod
      : source.spec_ngram_mod;
    normalized.ngram_mod = isNgramModValue(explicit);
    delete normalized.spec_ngram_mod;
  } else if (specTypes.includes("ngram-mod")) {
    normalized.ngram_mod = true;
  }

  const hasExplicitNgramMap =
    Object.prototype.hasOwnProperty.call(source, "ngram_map_k4v") ||
    Object.prototype.hasOwnProperty.call(source, "spec_ngram_map_k4v");
  if (hasExplicitNgramMap) {
    const explicit = Object.prototype.hasOwnProperty.call(source, "ngram_map_k4v")
      ? source.ngram_map_k4v
      : source.spec_ngram_map_k4v;
    normalized.ngram_map_k4v = isNgramMapK4vValue(explicit);
    delete normalized.spec_ngram_map_k4v;
  } else if (specTypes.includes("ngram-map-k4v")) {
    normalized.ngram_map_k4v = true;
  }

  if (specTypes.includes("ngram-mod") || specTypes.includes("ngram-map-k4v")) {
    const withoutNgram = specTypes.filter((t) => t !== "ngram-mod" && t !== "ngram-map-k4v");
    normalized.spec_type = withoutNgram.join(",") || "none";
  }
  return normalized;
}

/** defaults ← user values, with speculative normalization applied. */
export function buildEffectiveFlagValues(values: FlagValues): FlagValues {
  const effective: FlagValues = { ...getDefaultValues(), ...normalizeSpeculativeFlagValues(values) };
  const cloned: FlagValues = {};
  for (const [key, value] of Object.entries(effective)) {
    cloned[key] = cloneFlagValue(value);
  }
  return cloned;
}

// ---------------------------------------------------------------------------
// Value omission rules
// ---------------------------------------------------------------------------

function isValidGpuLayersValue(val: unknown): boolean {
  if (val === undefined || val === null || val === "") return false;
  const s = String(val).trim();
  if (s === "auto" || s === "all") return true;
  return /^\d+$/.test(s);
}

function normalizeGpuLayersValue(val: unknown): string | undefined {
  if (!isValidGpuLayersValue(val)) return undefined;
  return String(val).trim();
}

/** Values equal to the CLI's own default are omitted so the command stays clean. */
const INERT_DEFAULT_VALUES: Record<string, number | string> = {
  n_predict: -1,
  keep: 0,
  threads: -1,
  image_min_tokens: -1,
  image_max_tokens: -1,
  mtmd_batch_max_tokens: 1024,
  top_n_sigma: -1,
  xtc_probability: 0,
  xtc_threshold: 1.0,
  typical_p: 1.0,
  repeat_penalty: 1.0,
  presence_penalty: 0,
  frequency_penalty: 0,
  dry_multiplier: 0,
  dry_base: 1.75,
  dry_allowed_length: 2,
  dry_penalty_last_n: -1,
  dynatemp_range: 0,
  dynatemp_exp: 1.0,
  mirostat: "0",
  seed: -1,
  yarn_orig_ctx: 0,
  yarn_ext_factor: -1,
  yarn_attn_factor: -1,
  yarn_beta_slow: -1,
  yarn_beta_fast: -1,
  reasoning_budget: -1,
  reasoning_format: "auto",
  cache_reuse: 0,
  ctx_checkpoints: 32,
  checkpoint_every_n_tokens: 256,
};

function shouldOmitFlagValue(f: FlagDef, value: unknown): boolean {
  const expected = INERT_DEFAULT_VALUES[f.id];
  if (expected === undefined) return false;
  if (typeof expected === "number") return Number(value) === expected;
  return String(value) === String(expected);
}

/** Empty-ish values compare equal to "unset" so clearing a field isn't reported as modified. */
function normVal(v: unknown): unknown {
  return v === undefined || v === null || v === "" ? null : v;
}

/** True when an effective flag value differs from the definition's default (ConfigureView dot). */
export function isFlagModified(f: FlagDef, values: FlagValues): boolean {
  const a = normVal(values[f.id]);
  // A value equal to the CLI's own default emits no argument at all — not "modified" in any observable way.
  if (a !== null && shouldOmitFlagValue(f, a)) return false;
  const b = normVal(f.default);
  if (a === null && b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
  }
  return String(a) !== String(b);
}

function isMirostatEnabled(values: FlagValues): boolean {
  const mode = String((values || {}).mirostat ?? "0").trim();
  return mode === "1" || mode === "2";
}

/** When load_mode is set, the legacy mlock/mmap/direct_io flags are superseded. */
export function shouldOmitLegacyLoadFlag(f: FlagDef, values: FlagValues): boolean {
  const loadMode = String((values || {}).load_mode ?? "").trim();
  return Boolean(loadMode) && new Set(["mlock", "mmap", "direct_io"]).has(f.id);
}

const NGram_MOD_TUNING = new Set(["ngram_mod_n_match", "ngram_mod_n_min", "ngram_mod_n_max"]);
const NGRAM_MAP_K4V_TUNING = new Set(["ngram_map_k4v_size_n", "ngram_map_k4v_size_m", "ngram_map_k4v_min_hits"]);
const DRAFT_MODEL_ONLY_FLAGS = new Set([
  "draft_max",
  "draft_min",
  "draft_p_min",
  "draft_p_split",
  "gpu_layers_draft",
  "draft_device",
  "draft_cache_type_k",
  "draft_cache_type_v",
]);

function shouldOmitSpeculativeFlag(f: FlagDef, values: FlagValues): boolean {
  if (f.category !== "speculative") return false;
  if (!isSpeculativeDecodingEnabled(values)) return true;

  if (f.id === "spec_type") {
    const specTypes = getSpeculativeTypeParts(values).filter(
      (type) => type !== "none" && type !== "ngram-mod" && type !== "ngram-map-k4v",
    );
    return specTypes.length === 0 && !isNgramModEnabled(values) && !isNgramMapK4vEnabled(values);
  }

  if (f.id === "ngram_mod" || f.id === "ngram_map_k4v") return true; // emitted via spec_type combo
  if (NGram_MOD_TUNING.has(f.id)) return !isNgramModEnabled(values);
  if (NGRAM_MAP_K4V_TUNING.has(f.id)) return !isNgramMapK4vEnabled(values);

  return DRAFT_MODEL_ONLY_FLAGS.has(f.id) && !hasDraftModelSpeculation(values);
}

// ---------------------------------------------------------------------------
// Custom launch args
// ---------------------------------------------------------------------------

function parseCustomLaunchArgs(raw: string): { tokens?: string[]; error?: string } {
  const input = String(raw || "");
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escaping) {
      token += ch;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        const nextCh = input[i + 1];
        if (nextCh === undefined) {
          escaping = true;
          continue;
        }
        if (/[\s'"\\]/.test(nextCh)) {
          escaping = true;
          continue;
        }
        token += ch;
        tokenStarted = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      token += ch;
      tokenStarted = true;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        continue;
      }
      token += ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (ch === "\\") {
      const nextCh = input[i + 1];
      if (nextCh !== undefined && /[\s'"\\]/.test(nextCh)) {
        escaping = true;
        continue;
      }
      token += ch;
      tokenStarted = true;
      continue;
    }

    token += ch;
    tokenStarted = true;
  }

  if (escaping) return { error: "Custom launch args end with an unfinished escape." };
  if (quote) {
    return { error: `Custom launch args contain an unmatched ${quote === "'" ? "single" : "double"} quote.` };
  }
  if (tokenStarted) tokens.push(token);
  return { tokens };
}

// FLAGS is a stable module-level array (never mutated), so these sets are built once.

/** All CLI flag names the app knows about — used to warn when custom args duplicate UI-managed flags. */
const KNOWN_CLI_FLAGS: Set<string> = (() => {
  const names = new Set<string>();
  for (const f of FLAGS) {
    names.add(f.flag);
    if (f.false_flag) names.add(f.false_flag);
  }
  // Model flags are not in FLAGS but the app emits them.
  for (const f of ["-m", "--model", "-hf", "--hf-repo", "-mu", "--model-url"]) {
    names.add(f);
  }
  return names;
})();

function getCustomArgFlagName(token: string): string {
  const value = String(token || "");
  if (!value.startsWith("-")) return value;
  const eqIndex = value.indexOf("=");
  return eqIndex > 0 ? value.slice(0, eqIndex) : value;
}

/** Flags whose values must never appear in the copyable command preview. */
const SENSITIVE_CLI_FLAGS: Set<string> = (() => {
  const s = new Set(["--api-key", "-hft", "--hf-token"]);
  for (const f of FLAGS) if (f.sensitive && f.flag) s.add(f.flag);
  return s;
})();

// Cached array form — redactSensitiveTokens scans it per token, so avoid re-allocating.
const SENSITIVE_CLI_FLAG_NAMES = Array.from(SENSITIVE_CLI_FLAGS);

// ---------------------------------------------------------------------------
// Command preview helpers
// ---------------------------------------------------------------------------

/** Shell-quotes a single token for the copyable command preview. */
export function quoteArg(arg: string): string {
  const text = String(arg);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export function redactSensitiveTokens(tokens: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const rawToken of tokens || []) {
    const token = String(rawToken);
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }
    const matchedEqualsFlag = SENSITIVE_CLI_FLAG_NAMES.find((flag) => token.startsWith(flag + "="));
    if (matchedEqualsFlag) {
      redacted.push(matchedEqualsFlag + "=<redacted>");
      continue;
    }
    redacted.push(token);
    if (SENSITIVE_CLI_FLAGS.has(token)) redactNext = true;
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Binary tag gate (llama.cpp b10434+ has native --reasoning-effort)
// ---------------------------------------------------------------------------

function supportsNativeReasoningEffort(tag?: string): boolean {
  const match = /^b(\d+)$/.exec(String(tag || ""));
  return match !== null && Number(match[1]) >= 10434;
}

// ---------------------------------------------------------------------------
// buildLaunchArgs — the single source of truth for CLI construction
// ---------------------------------------------------------------------------

export function buildLaunchArgs(
  state: { tool: Tool; model?: string; flags: FlagValues; binaryTag?: string },
): LaunchArgsResult {
  const args: LaunchArg[] = [];
  const warnings: string[] = [];
  const launchState: { tool?: Tool; model?: string; flags?: FlagValues; binaryTag?: string } =
    state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const tool = launchState.tool;
  const values: FlagValues =
    launchState.flags && typeof launchState.flags === "object" && !Array.isArray(launchState.flags)
      ? launchState.flags
      : {};
  const model = String(launchState.model || "");

  if (tool !== "llama-server" && tool !== "llama-cli") {
    return { args, error: "Unsupported llama.cpp tool.", warnings };
  }
  const toolBase = tool.replace("llama-", "");
  const nativeEffort = supportsNativeReasoningEffort(launchState.binaryTag);

  for (const f of FLAGS) {
    if (f.tool !== "both" && f.tool !== toolBase) continue;
    if (f.id === "ngram_mod" || f.id === "ngram_map_k4v") continue; // emitted via spec_type combo
    if (values.fit === "off" && (f.id === "fit_target" || f.id === "fit_ctx")) continue;
    if (f.id === "kv_unified_per_slot" && values.kv_unified === "disabled") continue;
    if (shouldOmitSpeculativeFlag(f, values)) continue;
    if (shouldOmitLegacyLoadFlag(f, values)) continue;
    const val = values[f.id];

    if (f.id === "spec_type") {
      const specType = getCombinedSpeculativeType(values);
      if (specType) args.push([f.flag, specType]);
      continue;
    }

    if (f.id === "chat_template_reasoning_effort") {
      if (val && val !== "auto") {
        if (nativeEffort) {
          args.push([f.flag, String(val)]);
        } else {
          const kwargs: Record<string, unknown> = {};
          if (values.preserve_thinking === true) kwargs.preserve_thinking = true;
          kwargs.reasoning_effort = val;
          args.push(["--chat-template-kwargs", JSON.stringify(kwargs)]);
        }
      }
      continue;
    }

    if (f.id === "preserve_thinking") {
      // On the legacy path with a non-auto effort, preserve_thinking is merged into
      // the single kwargs object emitted above.
      const mergedIntoEffortKwargs =
        toolBase === "server" &&
        !nativeEffort &&
        Boolean(values.chat_template_reasoning_effort) &&
        values.chat_template_reasoning_effort !== "auto";
      if (val === true && !mergedIntoEffortKwargs) {
        args.push([f.flag, '{"preserve_thinking":true}']);
      }
      continue;
    }

    if (val === undefined || val === null || val === "") continue;

    if (f.type === "bool") {
      if (val === true) {
        args.push(f.flag);
      } else if (val === false && f.false_flag) {
        args.push(f.false_flag);
      }
    } else if (f.type === "multi_enum") {
      const selectedValues = Array.isArray(val) ? val : [];
      const allowedValues = new Set((f.options || []).map((o) => String(o.value)));
      const supportedValues = selectedValues.filter((v) => allowedValues.has(String(v)));
      for (const value of selectedValues.filter((v) => !allowedValues.has(String(v)))) {
        warnings.push(`Unsupported ${f.label || f.id} value "${value}" — omitted.`);
      }
      if (supportedValues.length > 0) {
        args.push([f.flag, supportedValues.join(",")]);
      }
    } else if (f.type === "text_list") {
      const items = Array.isArray(val) ? val : String(val).split(/\r?\n/);
      for (const item of items) {
        const normalized = String(item).trim();
        if (normalized) args.push([f.flag, normalized]);
      }
    } else {
      if (f.id === "kv_unified") {
        if (val === "enabled") {
          args.push(f.flag);
        } else if (val === "disabled" && f.false_flag) {
          args.push(f.false_flag);
        }
        continue;
      }
      if (f.id === "chat_template" && String(values.chat_template_custom || "").trim()) {
        continue; // custom template wins over the preset
      }
      if (f.id === "gpu_layers") {
        const normalizedGpuLayers = normalizeGpuLayersValue(val);
        if (normalizedGpuLayers === undefined) continue;
        if (shouldOmitFlagValue(f, normalizedGpuLayers)) continue;
        args.push([f.flag, normalizedGpuLayers]);
        continue;
      }
      if (f.id === "checkpoint_every_n_tokens" && Number(val) < 0) {
        args.push([f.flag, "0"]);
        continue;
      }
      if ((f.id === "mirostat_lr" || f.id === "mirostat_ent") && !isMirostatEnabled(values)) {
        continue;
      }
      if (shouldOmitFlagValue(f, val)) continue;
      args.push([f.flag, String(val)]);
    }
  }

  const customRaw = values.custom_args;
  if (customRaw !== undefined && customRaw !== null && String(customRaw).trim()) {
    const parsedCustom = parseCustomLaunchArgs(String(customRaw));
    if (parsedCustom.error) {
      return { args, error: parsedCustom.error, warnings };
    }

    // TODO: token-naive duplicate detection — values that happen to equal known flag
    // strings are mis-flagged. Fix with flag/value pairing when user-visible false positives appear.
    const duplicates = Array.from(
      new Set((parsedCustom.tokens ?? []).map(getCustomArgFlagName).filter((t) => KNOWN_CLI_FLAGS.has(t))),
    );
    if (duplicates.length > 0) {
      warnings.push(`Custom launch args duplicate UI-managed flags: ${duplicates.join(", ")}`);
    }
    args.push(...(parsedCustom.tokens ?? []));
  }

  // Our app passes absolute model paths (user-picked), no models-dir machinery.
  if (model) {
    args.push(["-m", model]);
  }

  return { args, error: null, warnings };
}

/** Flatten + redact + quote into a copyable command line for the preview box. */
export function renderCommand(tool: Tool, result: LaunchArgsResult): string {
  const launchTokens = flattenArgs(result.args);
  const binary = `${tool}.exe`; // Windows-only app
  const parts = [binary, ...redactSensitiveTokens(launchTokens)];
  return parts.map(quoteArg).join(" ");
}
