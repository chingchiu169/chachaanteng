import { listen } from "@tauri-apps/api/event";

/** Context of the in-flight benchmark run — set by BenchmarksView on start/restore. */
interface BenchRunCtx {
  tool: string;
  model: string;
  startedAtMs: number | null;
}

interface BenchExitInfo {
  code: number | null;
  atMs: number;
}

// App-lifetime bench event routing — same reason as server-events.ts: listeners must survive
// HMR remounts / StrictMode double-mount, so a run finishing while the page is hidden still
// gets its lines and exit recorded. ALL working state (not just listener registration) lives on
// a window singleton: under Vite ?t= fragmentation two live instances of this module can coexist,
// events flow into whichever registered first, and every instance must read/write the same buffer.
interface BenchEventsState {
  lines: string[];
  ctx: BenchRunCtx | null;
  /** Exit of the most recent run not yet consumed by the view. */
  pendingExit: BenchExitInfo | null;
  lineSubs: Set<(line: string) => void>;
  exitSubs: Set<(info: BenchExitInfo) => void>;
}

const w = window as unknown as { __benchEvents?: BenchEventsState };
const st: BenchEventsState = (w.__benchEvents ??= {
  lines: [],
  ctx: null,
  pendingExit: null,
  lineSubs: new Set(),
  exitSubs: new Set(),
});

export function setBenchRunContext(next: BenchRunCtx): void {
  st.ctx = next;
}
/** Start a fresh run — clears the previous run's buffer/exit so they can't leak into it. */
export function resetBenchEvents(next: BenchRunCtx): void {
  st.lines = [];
  st.ctx = next;
  st.pendingExit = null;
}
export function benchRunContext(): BenchRunCtx | null {
  return st.ctx;
}
/** All lines of the current run — survives HMR remounts (window-singleton state). */
export function benchLines(): string[] {
  return [...st.lines];
}
export function consumePendingExit(): BenchExitInfo | null {
  const p = st.pendingExit;
  st.pendingExit = null;
  return p;
}

export function onBenchLine(fn: (line: string) => void): () => void {
  st.lineSubs.add(fn);
  return () => {
    st.lineSubs.delete(fn);
  };
}
export function onBenchExit(fn: (info: BenchExitInfo) => void): () => void {
  st.exitSubs.add(fn);
  return () => {
    st.exitSubs.delete(fn);
  };
}

export function ensureBenchEvents(): void {
  // Window flag, not module scope — same HMR rationale as the other app-lifetime sync modules.
  const w = window as unknown as Record<string, unknown>;
  if (w.__benchEventsStarted) return;
  w.__benchEventsStarted = true;
  void listen<{ line: string }>("bench-output", (e) => {
    st.lines.push(e.payload.line);
    if (st.lines.length > 20000) st.lines.splice(0, st.lines.length - 20000);
    for (const fn of st.lineSubs) fn(e.payload.line);
  });
  void listen<{ code: number | null }>("bench-exited", (e) => {
    const info: BenchExitInfo = { code: e.payload.code, atMs: Date.now() };
    st.pendingExit = info; // the view consumes it — live or on its next mount
    for (const fn of st.exitSubs) fn(info);
  });
}
