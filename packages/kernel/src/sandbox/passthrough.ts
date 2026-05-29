// passthrough — the dev-only no-op boundary.
//
// No isolation: tools run with the host process's permissions. It exists
// for local development and debugging only. A passthrough run must NEVER be
// silent — on construction it emits a structured warning through the audit
// surface (audit type "tool-call", the kernel-baseline tool-audit channel)
// so the absence of isolation is recorded in `state.db`, not just printed
// to a console that nobody keeps. The warning carries no self-minted
// timestamp: the substrate never reads a wall clock, so any time stamping
// is the caller's to add.

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import type {
  ExecOptions,
  ExecResult,
  SandboxPlugin,
} from "../types/plugins.js";

export interface PassthroughSandboxOptions {
  // Sink for the startup warning. Wired to the same audit channel tool
  // calls use, so the no-isolation notice survives in state.db. When
  // omitted (e.g. a pure selection probe), the warning is skipped.
  audit_emit?: (payload: Record<string, unknown>) => void;
}

export function createPassthroughSandbox(
  opts?: PassthroughSandboxOptions,
): SandboxPlugin {
  opts?.audit_emit?.({
    type: "tool-call",
    sandbox: "passthrough",
    warning:
      "passthrough sandbox provides no isolation; tools run with the host " +
      "process's permissions — development use only",
    verdict: "warning",
  });

  return {
    name: "passthrough",
    capabilities: {
      filesystem_isolation: false,
      network_isolation: false,
      process_isolation: false,
      resource_limits: false,
    },

    exec(cmd: string, options: ExecOptions): Promise<ExecResult> {
      return new Promise<ExecResult>((resolveExec) => {
        const child = spawn(cmd, {
          shell: true,
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (options.timeout_ms !== undefined) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeout_ms);
        }

        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });

        if (options.stdin !== undefined) {
          child.stdin?.end(options.stdin);
        }

        child.on("close", (code, signal) => {
          if (timer !== undefined) clearTimeout(timer);
          // A process killed by signal (e.g. the timeout's SIGKILL) reports
          // a null exit code — surface it as the conventional 128+signal so
          // a killed run is never mistaken for a clean exit 0.
          const exitCode =
            code ?? (signal === "SIGKILL" ? 137 : signal ? 1 : 0);
          resolveExec({
            exit_code: exitCode,
            stdout,
            stderr,
            // 0 by contract — the substrate never reads a clock; the calling
            // tool-runner stamps the real elapsed time.
            duration_ms: 0,
            timed_out: timedOut,
          });
        });

        child.on("error", (err) => {
          if (timer !== undefined) clearTimeout(timer);
          resolveExec({
            exit_code: 127,
            stdout,
            stderr: stderr + String(err),
            duration_ms: 0,
            timed_out: timedOut,
          });
        });
      });
    },

    read_file(path: string): Promise<string> {
      return readFile(path, "utf8");
    },

    async write_file(path: string, content: string): Promise<void> {
      await writeFile(path, content, "utf8");
    },
  };
}
