/** Parse Prometheus text exposition into a flat name → value map.
 *  Labels are stripped (`name{a="b"}` → `name`), blank/comment lines skipped, and unknown
 *  metrics ignored — the parser is generic on purpose so metric-name drift between
 *  llama.cpp builds degrades to "missing tile", never a crash. */
export function parsePrometheus(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0].replace(/\{.*\}$/, "");
    const value = Number(parts[1]);
    if (Number.isFinite(value)) out[name] = value;
  }
  return out;
}
