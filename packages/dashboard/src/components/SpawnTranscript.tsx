// One spawn's transcript — the prompt it was given and the raw output it
// produced (plus the structured parse + usage), fetched on demand from
// `GET /projects/:id/spawn/:run_id`. Used in the chain card (read what each
// spawn did) and at the gate (read WHAT you are approving before you answer).
//
// Domain-blind: it renders the generic transcript fields and names no agent /
// gate / bundle concept — everything is DATA off the API.

import { useState } from "react";

import { api, errText } from "../lib/api.js";
import { parseChecksEnvelope, type CheckChip } from "../lib/checks.js";
import { cx } from "../lib/cx.js";
import type { SpawnTranscript, SpawnTranscriptResponse } from "../lib/types.js";
import styles from "./SpawnTranscript.module.css";

// Lazily load and render a spawn's transcript. `autoOpen` (the gate case) fetches
// immediately and shows the output expanded; the chain case opens on demand.
export function SpawnTranscriptView({
  projectId,
  runId,
  autoOpen = false,
}: {
  projectId: string;
  runId: string;
  autoOpen?: boolean;
}) {
  const [data, setData] = useState<SpawnTranscript | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    if (loaded || loading) return;
    setLoading(true);
    try {
      const r = await api<SpawnTranscriptResponse>(
        "GET",
        `/projects/${encodeURIComponent(projectId)}/spawn/${encodeURIComponent(runId)}`,
      );
      setData(r.transcript);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  };

  if (autoOpen && !loaded && !loading) void load();

  if (!loaded && !autoOpen) {
    return (
      <button className={styles.loadBtn} onClick={() => void load()}>
        {loading ? "reading transcript…" : "▸ transcript (prompt + output)"}
      </button>
    );
  }
  if (loading) return <div className={styles.note}>reading transcript…</div>;
  if (err !== null) return <div className={styles.note}>could not read the transcript: {err}</div>;
  if (data === null) return <div className={styles.note}>no transcript recorded for this spawn</div>;

  // A deterministic-checks envelope renders as status chips instead of raw
  // JSON — detected by DATA SHAPE, never by agent name.
  const chips = parseChecksEnvelope(data.raw_output);

  return (
    <div className={styles.box}>
      {chips !== null ? (
        <ChecksSummary chips={chips} />
      ) : (
        <Field label="output" body={data.raw_output} defaultOpen={autoOpen} />
      )}
      <Field label="prompt" body={data.prompt} defaultOpen={false} />
      <Parse parse={data.parse_result} />
    </div>
  );
}

const CHIP_GLYPH: Record<CheckChip["status"], string> = {
  ok: "✓",
  fail: "✗",
  skipped: "—",
};

const CHIP_CLASS: Record<CheckChip["status"], string> = {
  ok: styles.checkOk ?? "",
  fail: styles.checkFail ?? "",
  skipped: styles.checkSkip ?? "",
};

// The chip row for a checks envelope: one chip per check; a failed chip expands
// to its captured output (head-first — where a compiler puts the first error).
function ChecksSummary({ chips }: { chips: CheckChip[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const expandable = (c: CheckChip): boolean => c.status === "fail" && c.output !== null;
  const current = chips.find((c) => c.name === open);
  return (
    <div className={styles.checks}>
      <div className={styles.checksRow}>
        {chips.map((c) => (
          <button
            key={c.name}
            type="button"
            className={cx(styles.checkChip, CHIP_CLASS[c.status])}
            disabled={!expandable(c)}
            title={c.command ?? undefined}
            onClick={() => setOpen((o) => (o === c.name ? null : c.name))}
          >
            {CHIP_GLYPH[c.status]} {c.name}
            {c.status === "fail" && c.exit_code !== null ? ` (exit ${c.exit_code})` : ""}
          </button>
        ))}
      </div>
      {current !== undefined && current.output !== null && (
        <pre className={styles.body}>{current.output}</pre>
      )}
    </div>
  );
}

function Field({ label, body, defaultOpen }: { label: string; body: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const text = body.length > 0 ? body : "(empty)";
  return (
    <div className={styles.field}>
      <button className={styles.fieldHead} onClick={() => setOpen((o) => !o)}>
        <span className={styles.caret}>{open ? "▾" : "▸"}</span> {label}
        <span className={styles.size}>{body.length.toLocaleString()} chars</span>
      </button>
      {open && <pre className={cx(styles.body, body.length === 0 && styles.empty)}>{text}</pre>}
    </div>
  );
}

function Parse({ parse }: { parse: SpawnTranscript["parse_result"] }) {
  const mod = parse.files_modified ?? [];
  const cre = parse.files_created ?? [];
  if (mod.length === 0 && cre.length === 0) return null;
  return (
    <div className={styles.parse}>
      {mod.length > 0 && <div>modified: {mod.join(", ")}</div>}
      {cre.length > 0 && <div>created: {cre.join(", ")}</div>}
    </div>
  );
}
