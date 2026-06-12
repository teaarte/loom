// Deterministic checks executor — mapping of command outcomes to the structured
// envelope, with the CHILD PROCESS faked (never the database). One real-spawn
// smoke proves the default runner's exit-code capture against an actual process;
// the rest inject a runner so ok / fail / skipped / timeout / output-tail-cap are
// asserted without racing real subprocess timing.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createChecksExecutor,
  headCap,
  tailCap,
  type CheckCommandOutcome,
  type CheckCommandRunner,
  type ChecksEnvelope,
  type CheckSpec,
  type WorktreeProvision,
} from "../src/index.js";
import type { ProviderShuttleIntent } from "@loomfsm/kernel";

// The worktree-relative path the executor writes the full failure report to.
const FAILURES_REL = join(".loom", "work", "check-failures.txt");

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-checks-exec-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INTENT: ProviderShuttleIntent = {
  agent: "checks-runner",
  agent_run_id: "ar-00000000-0000-0000-0000-000000000000",
  phase: "implementation",
  model: "fast",
  prompt: "",
};

// A fixed, non-isolated provision so the executor never touches git / a real
// worktree — the checks logic under test is the command→envelope mapping.
function fixedProvision(dir: string): () => WorktreeProvision {
  return () => ({ dir, baseline: null, isolated: false });
}

// A runner that answers from a substring→outcome table (the key is matched
// against the full `bin + args` command line), recording which commands ran.
function tableRunner(
  table: Record<string, CheckCommandOutcome>,
  ran: string[],
): CheckCommandRunner {
  return (spec) => {
    const line = [spec.bin, ...spec.args].join(" ");
    ran.push(line);
    for (const [key, outcome] of Object.entries(table)) {
      if (line.includes(key)) return Promise.resolve(outcome);
    }
    return Promise.resolve({ exit_code: 0, output_tail: "", timed_out: false });
  };
}

async function runEnvelope(opts: {
  specs: CheckSpec[];
  runner: CheckCommandRunner;
  dir: string;
}): Promise<ChecksEnvelope> {
  const exec = createChecksExecutor({
    project_dir: opts.dir,
    provision: fixedProvision(opts.dir),
    resolveCommands: () => opts.specs,
    runCommand: opts.runner,
  });
  const result = await exec.execute(INTENT);
  assert.equal(result.files_modified, undefined, "checks must report no file delta");
  assert.equal(result.files_created, undefined, "checks must report no file delta");
  return JSON.parse(result.agent_output) as ChecksEnvelope;
}

describe("createChecksExecutor — outcome mapping (faked child)", () => {
  it("maps exit 0 → ok, non-zero → fail, and carries exit_code + command", async () => {
    const dir = tmp();
    const ran: string[] = [];
    const env = await runEnvelope({
      dir,
      runner: tableRunner(
        {
          typecheck: { exit_code: 0, output_tail: "no errors", timed_out: false },
          "eslint .": { exit_code: 2, output_tail: "3 problems", timed_out: false },
        },
        ran,
      ),
      specs: [
        { name: "typecheck", run: { kind: "argv", argv: ["pnpm", "run", "typecheck"], display: "pnpm run typecheck" } },
        { name: "lint", run: { kind: "shell", command: "eslint ." } },
      ],
    });
    const tc = env.checks.find((c) => c.name === "typecheck");
    const lint = env.checks.find((c) => c.name === "lint");
    assert.equal(tc?.status, "ok");
    assert.equal(tc?.exit_code, 0);
    assert.equal(tc?.command, "pnpm run typecheck");
    assert.equal(lint?.status, "fail");
    assert.equal(lint?.exit_code, 2);
    assert.equal(lint?.command, "eslint .");
    // The shell-kind check ran via /bin/sh -c with the command verbatim.
    assert.ok(ran.includes("/bin/sh -c eslint ."), `shell command not run verbatim: ${ran.join(" | ")}`);
  });

  it("records a skip spec as status 'skipped' with no command, and never runs it", async () => {
    const dir = tmp();
    const ran: string[] = [];
    const env = await runEnvelope({
      dir,
      runner: tableRunner({}, ran),
      specs: [
        { name: "typecheck", run: { kind: "skip", reason: "no command configured" } },
        { name: "lint", run: { kind: "skip", reason: "no command configured" } },
        { name: "test", run: { kind: "skip", reason: "no command configured" } },
      ],
    });
    assert.equal(ran.length, 0, "skip specs must not invoke the runner (detection-fallback)");
    for (const c of env.checks) {
      assert.equal(c.status, "skipped");
      assert.equal(c.command, undefined);
    }
  });

  it("maps a timed-out command to fail with a timeout note appended", async () => {
    const dir = tmp();
    const env = await runEnvelope({
      dir,
      runner: () => Promise.resolve({ exit_code: null, output_tail: "partial output", timed_out: true }),
      specs: [{ name: "test", run: { kind: "shell", command: "node --test" } }],
    });
    const t = env.checks.find((c) => c.name === "test");
    assert.equal(t?.status, "fail");
    assert.equal(t?.exit_code, null);
    assert.match(t?.output_tail ?? "", /timeout/);
  });

  it("preserves command order in the envelope", async () => {
    const dir = tmp();
    const env = await runEnvelope({
      dir,
      runner: tableRunner({}, []),
      specs: [
        { name: "typecheck", run: { kind: "shell", command: "a" } },
        { name: "lint", run: { kind: "shell", command: "b" } },
        { name: "test", run: { kind: "shell", command: "c" } },
      ],
    });
    assert.deepEqual(env.checks.map((c) => c.name), ["typecheck", "lint", "test"]);
  });
});

describe("tailCap — output tail capping", () => {
  it("passes a short string through unchanged", () => {
    assert.equal(tailCap("short", 1024), "short");
  });

  it("keeps the LAST bytes and marks the omission when over the cap", () => {
    const big = "x".repeat(100) + "TAIL";
    const capped = tailCap(big, 16);
    assert.ok(capped.endsWith("TAIL"), "tail must be retained");
    assert.match(capped, /earlier chars omitted/);
    assert.ok(capped.length < big.length);
  });
});

describe("createChecksExecutor — default runner (real child process)", () => {
  it("captures a real command's exit code + output", async () => {
    const dir = tmp();
    const exec = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      resolveCommands: () => [
        { name: "typecheck", run: { kind: "shell", command: "printf hello && exit 0" } },
        { name: "test", run: { kind: "shell", command: "printf boom >&2 && exit 7" } },
      ],
    });
    const env = JSON.parse((await exec.execute(INTENT)).agent_output) as ChecksEnvelope;
    const tc = env.checks.find((c) => c.name === "typecheck");
    const t = env.checks.find((c) => c.name === "test");
    assert.equal(tc?.status, "ok");
    assert.equal(tc?.exit_code, 0);
    assert.match(tc?.output_tail ?? "", /hello/);
    assert.equal(t?.status, "fail");
    assert.equal(t?.exit_code, 7);
    assert.match(t?.output_tail ?? "", /boom/);
  });

  it("reports a missing command as a failed check (not a thrown error)", async () => {
    const dir = tmp();
    const exec = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      resolveCommands: () => [
        { name: "lint", run: { kind: "argv", argv: ["loom-no-such-binary-xyz"], display: "loom-no-such-binary-xyz" } },
      ],
    });
    const env = JSON.parse((await exec.execute(INTENT)).agent_output) as ChecksEnvelope;
    const lint = env.checks.find((c) => c.name === "lint");
    assert.equal(lint?.status, "fail");
    assert.match(lint?.output_tail ?? "", /not found/);
    // A missing tool leaves no other output, so the head (which the finding is
    // built from) must still carry the diagnosis.
    assert.match(lint?.output_head ?? "", /not found/);
  });

  it("captures the output HEAD (first errors) AND the tail (final summary) of a long run", async () => {
    const dir = tmp();
    // ~135 KB between the two markers: more than the head cap (32 KB), so the
    // head holds the FIRST marker and the tail holds the LAST.
    const exec = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      resolveCommands: () => [
        {
          name: "test",
          run: {
            kind: "shell",
            command:
              "printf 'HEAD_MARKER\\n'; yes 'pad-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 3000; printf 'TAIL_MARKER\\n'; exit 3",
          },
        },
      ],
    });
    const env = JSON.parse((await exec.execute(INTENT)).agent_output) as ChecksEnvelope;
    const t = env.checks.find((c) => c.name === "test");
    assert.equal(t?.status, "fail");
    assert.equal(t?.exit_code, 3);
    // The head leads with the first line and is bounded; the late marker is gone.
    assert.match(t?.output_head ?? "", /^HEAD_MARKER/);
    assert.doesNotMatch(t?.output_head ?? "", /TAIL_MARKER/);
    assert.match(t?.output_head ?? "", /later chars omitted/);
    // The tail retains the final marker (and shows its own omission notice).
    assert.match(t?.output_tail ?? "", /TAIL_MARKER/);
    assert.match(t?.output_tail ?? "", /earlier chars omitted/);
  });
});

describe("headCap — output head capping", () => {
  it("passes a short string through unchanged", () => {
    assert.equal(headCap("short", 1024), "short");
  });

  it("keeps the FIRST bytes and marks the omission when over the cap", () => {
    const big = "HEAD" + "x".repeat(100);
    const capped = headCap(big, 16);
    assert.ok(capped.startsWith("HEAD"), "head must be retained");
    assert.match(capped, /later chars omitted/);
    assert.ok(capped.length < big.length);
  });
});

describe("createChecksExecutor — the full failure report file", () => {
  it("writes one bounded section per failed check (head + omission + tail) into the worktree", async () => {
    const dir = tmp();
    // A head longer than the cap (so the executor clamps it + marks the omission)
    // and a distinct tail end the head does not contain.
    const head = "HEAD_START\n" + "A".repeat(40_000);
    const tail = "B".repeat(2_000) + "\nTAIL_END";
    const runner: CheckCommandRunner = () =>
      Promise.resolve({ exit_code: 2, output_head: head, output_tail: tail, timed_out: false });
    const exec = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      runCommand: runner,
      resolveCommands: () => [
        { name: "typecheck", run: { kind: "shell", command: "tsc --noEmit" } },
      ],
    });
    await exec.execute(INTENT);

    const path = join(dir, FAILURES_REL);
    assert.ok(existsSync(path), "a failed round must write the report");
    const text = readFileSync(path, "utf8");
    // The section header carries the check name, command, and exit code.
    assert.match(text, /=== typecheck — tsc --noEmit \(exit 2\) ===/);
    // Both bounds are present, with an omission marker between them.
    assert.match(text, /HEAD_START/);
    assert.match(text, /later chars omitted/);
    assert.match(text, /TAIL_END/);
    // Bounded: roughly the head cap (32 KB) plus an 8 KB tail, never the raw 40 KB+.
    assert.ok(text.length < 32 * 1024 + 8 * 1024 + 512, `report not bounded: ${text.length}`);
  });

  it("removes a stale report on a green round so a prior failure never haunts the next", async () => {
    const dir = tmp();
    // Round 1: a failure writes the file.
    const failing = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      runCommand: () => Promise.resolve({ exit_code: 1, output_head: "boom", output_tail: "boom", timed_out: false }),
      resolveCommands: () => [{ name: "test", run: { kind: "shell", command: "node --test" } }],
    });
    await failing.execute(INTENT);
    const path = join(dir, FAILURES_REL);
    assert.ok(existsSync(path), "the failing round must write the report");

    // Round 2: all green over the SAME worktree → the report is cleared.
    const green = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      runCommand: () => Promise.resolve({ exit_code: 0, output_head: "", output_tail: "", timed_out: false }),
      resolveCommands: () => [{ name: "test", run: { kind: "shell", command: "node --test" } }],
    });
    await green.execute(INTENT);
    assert.equal(existsSync(path), false, "a green round must remove the stale report");
  });

  it("writes no report when every check is ok or skipped", async () => {
    const dir = tmp();
    const exec = createChecksExecutor({
      project_dir: dir,
      provision: fixedProvision(dir),
      runCommand: () => Promise.resolve({ exit_code: 0, output_tail: "", timed_out: false }),
      resolveCommands: () => [
        { name: "typecheck", run: { kind: "shell", command: "tsc" } },
        { name: "lint", run: { kind: "skip", reason: "none" } },
      ],
    });
    await exec.execute(INTENT);
    assert.equal(existsSync(join(dir, FAILURES_REL)), false);
  });
});
