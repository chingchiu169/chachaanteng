/** Shared number formatters for live stats (Monitor tiles, sidebar server cards). */

/** Human-readable byte size; "—" when absent or zero. */
export function fmtBytes(bytes?: number | null): string {
  if (bytes == null || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`; // sub-MB — never "0 MB"
}

/** Grouped digits for cumulative counters — millions stay readable; "—" until first sample. */
export function fmtCount(v?: number | null): string {
  return v == null ? "—" : Math.round(v).toLocaleString();
}

/** tok/s as a bare whole number, for tiles whose label already says tok/s. */
export function fmtTok(v?: number | null): string {
  return v == null ? "—" : `${Math.round(v)}`;
}

/** tok/s with an inline suffix, for text rows without their own unit label. */
export function fmtTokS(v?: number | null): string {
  return v == null ? "—" : `${Math.round(v)} t/s`;
}

/** Bytes/sec throughput (disk, downloads). */
export function fmtRate(bps: number): string {
  const mb = bps / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bps / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB/s`;
  return `${Math.max(1, Math.round(bps))} B/s`; // sub-KB — never "0 KB/s"
}
