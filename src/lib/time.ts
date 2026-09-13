/** Format a wall-clock timestamp, honoring the user's 24h preference (settings.use_24h). */
export function fmtClock(ms: number, use24h?: boolean): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: !(use24h ?? false) });
}

/** Format a full timestamp (date + time), honoring the user's 24h preference. */
export function fmtDateTime(ms: number, use24h?: boolean): string {
  return new Date(ms).toLocaleString(undefined, { hour12: !(use24h ?? false) });
}
