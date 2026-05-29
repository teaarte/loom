// Deterministic tool-output compression.
//
// Verbose tools (grep, build output, logs) declare an `OutputCompressionPolicy`
// so the substrate shrinks `ToolResult.content` before it reaches the agent.
// This is a token-economy concern, not a security one, but it must be
// AUDITABLE and REPRODUCIBLE — the same input under the same policy always
// yields the same output, with no clock and no model call. The strategies
// here are the deterministic ones; `summarize` needs a provider seam and is
// a documented pass-through until that seam exists.

import type { OutputCompressionPolicy } from "../types/tool.js";

export interface CompressionResult {
  content: string;
  compressed: boolean;
  original_bytes: number;
  final_bytes: number;
}

// Defaults mirror the documented tool-surface contract: compress only when
// the output exceeds the threshold; aim for half the threshold.
export const DEFAULT_THRESHOLD_BYTES = 4000;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// Keep the last `targetBytes` worth of `s` without splitting a code point.
function tailWithinBytes(s: string, targetBytes: number): string {
  if (byteLen(s) <= targetBytes) return s;
  let start = 0;
  // Trim characters from the front until the tail fits the byte budget.
  while (start < s.length && byteLen(s.slice(start)) > targetBytes) start++;
  return s.slice(start);
}

// Keep the first `targetBytes` worth of `s` without splitting a code point.
function headWithinBytes(s: string, targetBytes: number): string {
  if (byteLen(s) <= targetBytes) return s;
  let end = s.length;
  while (end > 0 && byteLen(s.slice(0, end)) > targetBytes) end--;
  return s.slice(0, end);
}

// Collapse runs of identical consecutive lines into `<line> [×N]`,
// preserving order. Lossless for non-repeated lines.
function deduplicateLines(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    let count = 1;
    while (i + count < lines.length && lines[i + count] === line) count++;
    out.push(count > 1 ? `${line} [×${count}]` : line);
    i += count;
  }
  return out.join("\n");
}

export function applyOutputCompression(
  content: string,
  policy: OutputCompressionPolicy,
): CompressionResult {
  const original_bytes = byteLen(content);
  const threshold = policy.threshold_bytes ?? DEFAULT_THRESHOLD_BYTES;
  const target = policy.target_bytes ?? Math.floor(threshold / 2);

  const unchanged = (): CompressionResult => ({
    content,
    compressed: false,
    original_bytes,
    final_bytes: original_bytes,
  });

  // `summarize` needs a configured summary provider — out of scope here, so
  // it is an explicit no-op rather than a silent fallthrough.
  if (policy.strategy === "none" || policy.strategy === "summarize") {
    return unchanged();
  }

  // Compression only kicks in above the threshold.
  if (original_bytes <= threshold) return unchanged();

  let next: string;
  switch (policy.strategy) {
    case "truncate-head": {
      const tail = tailWithinBytes(content, target);
      const dropped = original_bytes - byteLen(tail);
      next = `…[truncated ${dropped} bytes] ${tail}`;
      break;
    }
    case "truncate-tail": {
      const head = headWithinBytes(content, target);
      const dropped = original_bytes - byteLen(head);
      next = `${head} […truncated ${dropped} bytes]`;
      break;
    }
    case "deduplicate": {
      next = deduplicateLines(content);
      break;
    }
    default: {
      // Unknown strategy — be conservative and pass through unchanged.
      return unchanged();
    }
  }

  const final_bytes = byteLen(next);
  return {
    content: next,
    compressed: next !== content,
    original_bytes,
    final_bytes,
  };
}
