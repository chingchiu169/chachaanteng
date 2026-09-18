import type { ConversationMeta, StoredMessage } from "./api";
import type { ChatContentPart } from "../types";

/** Stored user turns may be a JSON parts array (multimodal); validate and parse it, else null. */
export function parseParts(raw: string): ChatContentPart[] | null {
  if (!raw.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.length > 0 && v.every((p) => p && typeof p === "object" && ("text" in p || "image_url" in p))) {
      return v as ChatContentPart[];
    }
  } catch {
    /* not JSON — plain text that happens to start with "[" */
  }
  return null;
}

/** Plain text of a stored message — JSON parts arrays (multimodal user turns) yield their text
 *  parts plus an [image] marker per image; everything else is already plain text. */
export function storedText(content: string): string {
  const parts = parseParts(content);
  if (!parts) return content;
  return parts
    .map((p) => (p.type === "image_url" ? "[image]" : typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Markdown export: title/model/date header + role-labeled messages (raw transcript from the DB). */
export function convToMarkdown(title: string, modelPath: string | null, messages: StoredMessage[]): string {
  const lines: string[] = [`# ${title}`, ""];
  if (modelPath) lines.push(`- Model: \`${modelPath}\``);
  lines.push(`- Exported: ${new Date().toISOString()}`);
  for (const m of messages) {
    lines.push("", `## ${m.role === "user" ? "User" : "Assistant"}`, "", storedText(m.content), "");
  }
  return lines.join("\n");
}

/** JSON export — raw stored content strings, lossless. */
export function convToJson(
  meta: Pick<ConversationMeta, "title" | "model_path" | "params">,
  messages: StoredMessage[],
): string {
  return JSON.stringify(
    { title: meta.title, model_path: meta.model_path, params: meta.params ?? null, exported_at: new Date().toISOString(), messages },
    null,
    2,
  );
}
