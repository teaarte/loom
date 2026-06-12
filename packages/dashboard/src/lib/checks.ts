// Generic detection of a deterministic-checks envelope in a spawn's output —
// `{ checks: [{ name, status, … }] }`. Domain-blind: this parses a DATA SHAPE,
// not an agent name; any spawn whose output is such an envelope gets the chip
// rendering (the same spirit as the modified/created file parse). Pure + DOM
// free, so it unit-tests under tsconfig.node.json.

export interface CheckChip {
  name: string;
  status: "ok" | "fail" | "skipped";
  exit_code: number | null;
  command: string | null;
  // Failure evidence, head before tail (a compiler prints the first error
  // first); null when the envelope carried none.
  output: string | null;
}

function asStatus(v: unknown): CheckChip["status"] | null {
  return v === "ok" || v === "fail" || v === "skipped" ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Parse a raw spawn output into check chips, or null when the output is not a
// checks envelope (any JSON error, wrong shape, or empty list → null — the
// caller falls back to the plain transcript rendering).
export function parseChecksEnvelope(raw: string): CheckChip[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const checks = (parsed as { checks?: unknown }).checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;

  const out: CheckChip[] = [];
  for (const item of checks) {
    if (item === null || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    const name = str(o["name"]);
    const status = asStatus(o["status"]);
    if (name === null || status === null) return null;
    const head = str(o["output_head"]);
    const tail = str(o["output_tail"]);
    const output = head !== null && tail !== null && head !== tail ? `${head}\n…\n${tail}` : (head ?? tail);
    out.push({
      name,
      status,
      exit_code: typeof o["exit_code"] === "number" ? o["exit_code"] : null,
      command: str(o["command"]),
      output,
    });
  }
  return out;
}
