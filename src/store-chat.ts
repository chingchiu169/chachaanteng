import { create } from "zustand";

/** App-lifetime chat stream state — survives HMR remounts (window-singleton store).
 *  The streaming channel loop lives in a send() closure that outlives any component instance, so tokens
 *  keep arriving while the user is on another page. Keeping the partial reply HERE (not in view
 *  state) means returning to the chat mid-stream shows live output instead of nothing until the
 *  final persist lands. Same pattern as store-monitor.ts / lib/monitor-sync.ts. */
interface ChatStreamState {
  /** Conversation being streamed into — null when idle. */
  convId: number | null;
  streaming: boolean;
  content: string;
  reasoning: string;
  /** Set by fail() when the stream errors before end() clears it — shown as the reply bubble. */
  error: string | null;
  begin: (convId: number) => void;
  appendToken: (kind: "content" | "reasoning", text: string) => void;
  fail: (message: string) => void;
  end: () => void;
}

function makeChatStreamStore() {
  return create<ChatStreamState>((set) => ({
    convId: null,
    streaming: false,
    content: "",
    reasoning: "",
    error: null,
    begin: (convId) => set({ convId, streaming: true, content: "", reasoning: "", error: null }),
    appendToken: (kind, text) =>
      set((s) => (kind === "reasoning" ? { reasoning: s.reasoning + text } : { content: s.content + text })),
    fail: (message) => set({ streaming: false, error: message }),
    end: () => set({ convId: null, streaming: false, content: "", reasoning: "", error: null }),
  }));
}

// HMR-safe singleton — see store.ts for why a plain module-scope create() is not enough in dev.
const w = window as unknown as { __chatStreamStore?: ReturnType<typeof makeChatStreamStore> };
export const useChatStream: ReturnType<typeof makeChatStreamStore> = (w.__chatStreamStore ??= makeChatStreamStore());
