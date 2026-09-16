import { Fragment, useState } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Zero-dependency markdown renderer — port of the reference chat-rendering.js.
// Supports: fenced code blocks (lang + copy), headings, hr, blockquote, tables,
// ul/ol lists, paragraphs (<br> line joins) and inline bold/italic/del/code.
// ---------------------------------------------------------------------------

interface CodeBlock {
  lang: string;
  code: string;
}

function extractCodeBlocks(text: string): { text: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  const withPlaceholders = String(text ?? "").replace(
    /```([^\n`]*)\n([\s\S]*?)```/g,
    (_, rawLang, rawCode) => {
      const index = blocks.length;
      const lang = String(rawLang || "")
        .trim()
        .split(/\s+/)[0]
        .replace(/[^\w#+.-]/g, "")
        .slice(0, 32);
      blocks.push({ lang, code: String(rawCode || "").replace(/\n$/, "") });
      return `\u0000CODE_BLOCK_${index}\u0000`;
    },
  );
  return { text: withPlaceholders, blocks };
}

/** Inline formatting → React nodes (input must already be plain text). */
function renderInline(s: string): ReactNode[] {
  // Tokenize into segments of code / bold / italic / del / plain.
  const out: ReactNode[] = [];
  let rest = s;
  let key = 0;
  const pattern = /(`[^`\n]+?`)|(\*\*[^*]+\*\*)|(~~.+?~~)|((?<![\w*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\w*]))|((?<![\w_])_([^\s_](?:[^_]*?[^\s_])?)_(?![\w_]))/;
  while (rest.length > 0) {
    const m = pattern.exec(rest);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={key++} className="chat-inline-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key++}>{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={key++}>{renderInline(tok.slice(2, -2))}</del>);
    } else if (m[4]) {
      // *italic* — m[5] is the inner text
      out.push(<em key={key++}>{renderInline(m[5])}</em>);
    } else if (m[6]) {
      // _italic_ — m[7] is the inner text
      out.push(<em key={key++}>{renderInline(m[7])}</em>);
    } else {
      out.push(tok);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function CodeBlockView({ block }: { block: CodeBlock }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  };
  return (
    <div className="chat-code-block my-2 rounded-md border border-line-strong overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-raised text-[11px]">
        <span className="text-fg-muted font-mono">{block.lang || "Code"}</span>
        <button type="button" onClick={copy} className="text-fg-muted hover:text-fg-bright">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre data-lang={block.lang || undefined} className="px-3 py-2 overflow-x-auto bg-base text-[12px] leading-relaxed text-fg">
        <code>{block.code}</code>
      </pre>
    </div>
  );
}

interface Block {
  kind: "hr" | "heading" | "quote" | "table" | "ul" | "ol" | "p" | "code";
  level?: number;
  lines?: string[];
  rows?: string[][];
  text?: string;
  codeIndex?: number;
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: quoteLines });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (row: string) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        blocks.push({ kind: "table", rows: tableLines.map(parseRow) });
      }
      continue;
    }
    if (/^[\s]*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", lines: items });
      continue;
    }
    if (/^[\s]*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", lines: items });
      continue;
    }
    const codeMatch = line.match(/^\u0000CODE_BLOCK_(\d+)\u0000$/);
    if (codeMatch) {
      blocks.push({ kind: "code", codeIndex: Number(codeMatch[1]) });
      i++;
      continue;
    }
    // paragraph: contiguous plain lines joined with <br>
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !/^(#{1,6}\s|[\s]*[-*+]\s|[\s]*\d+\.\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) &&
      !/^\u0000CODE_BLOCK_\d+\u0000$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: "p", lines: paraLines });
    }
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const { text: stripped, blocks } = extractCodeBlocks(String(text ?? ""));
  // No manual escaping — React escapes at render time. (The ported reference escaped for
  // innerHTML; doing it here made literal > < & show up as "&gt;" / "&lt;" / "&amp;".)
  const parsed = parseBlocks(stripped);

  return (
    <div className="chat-markdown space-y-2 text-sm leading-relaxed">
      {parsed.map((b, i) => {
        switch (b.kind) {
          case "hr":
            return <hr key={i} className="border-line-strong" />;
          case "heading": {
            const level = b.level ?? 2;
            const cls = `font-semibold text-fg-bright ${level <= 2 ? "text-base" : "text-sm"}`;
            return (
              <div key={i} className={cls}>
                {renderInline(b.text ?? "")}
              </div>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-line-strong pl-3 text-fg-muted">
                {(b.lines ?? []).map((l, j) => (
                  <Fragment key={j}>
                    {renderInline(l)}
                    {j < (b.lines?.length ?? 1) - 1 && <br />}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className="border-collapse text-xs">
                  <thead>
                    <tr>
                      {(b.rows?.[0] ?? []).map((h, j) => (
                        <th key={j} className="border border-line px-2 py-1 bg-raised">
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(b.rows ?? []).slice(2).map((row, r) => (
                      <tr key={r}>
                        {row.map((c, j) => (
                          <td key={j} className="border border-line px-2 py-1">
                            {renderInline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc pl-5 space-y-0.5">
                {(b.lines ?? []).map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal pl-5 space-y-0.5">
                {(b.lines ?? []).map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case "code": {
            const block = blocks[b.codeIndex ?? 0];
            return block ? <CodeBlockView key={i} block={block} /> : null;
          }
          default:
            // paragraph — join lines with <br> like the reference
            return (
              <p key={i}>
                {(b.lines ?? []).map((l, j) => (
                  <Fragment key={j}>
                    {renderInline(l)}
                    {j < (b.lines?.length ?? 1) - 1 && <br />}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

/** Split leading `<think>` blocks out of streamed content (reference semantics). */
export function splitReasoningFromContent(content: string): { content: string; reasoning: string } {
  let remaining = String(content ?? "");
  const reasoningParts: string[] = [];
  const leadingThinkBlock = /^\s*<think(?:\s[^>]*)?>([\s\S]*?)<\/think>\s*/i;
  while (true) {
    const match = remaining.match(leadingThinkBlock);
    if (!match) break;
    reasoningParts.push(match[1].trim());
    remaining = remaining.slice(match[0].length);
  }
  return {
    content: reasoningParts.length ? remaining.trimStart() : remaining,
    reasoning: reasoningParts.filter(Boolean).join("\n\n"),
  };
}
