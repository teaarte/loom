// Deterministic checks executor — mapping of command outcomes to the structured
// envelope, with the CHILD PROCESS faked (never the database). One real-spawn
// smoke proves the default runner's exit-code capture against an actual process;
// the rest inject a runner so ok / fail / skipped / timeout / output-tail-cap are
// asserted without racing real subprocess timing.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createChecksExecutor,
  tailCap,
  type CheckCommandOutcome,
  type CheckCommandRunner,
  type ChecksEnvelope,
  type CheckSpec,
  type WorktreeProvision,
} from "../src/index.js";
import type { ProviderShuttleIntent } from "@loomfsm/kernel";

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
  });
});
