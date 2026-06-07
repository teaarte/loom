// CLI availability probes, shared by `loom run` / `loom daemon` / `loom serve`.
//
// Each command needs to know — before it wires up a backend — whether the
// Claude Code CLI and (optionally) the Docker daemon are reachable. The probes
// are tiny `spawnSync … --version` checks; they lived inline in three command
// files byte-for-byte, so they live here once.

import { spawnSync } from "node:child_process";

// Probe for the Claude Code CLI by spawning `<bin> --version`. A missing
// binary surfaces as a spawn error (ENOENT); a present one exits 0.
export function claudeAvailable(bin: string): boolean {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

// Probe for the Docker CLI + a reachable daemon by spawning `docker version`.
export function dockerAvailableDefault(): boolean {
  const bin = process.env["LOOM_DOCKER_BIN"] ?? "docker";
  const res = spawnSync(bin, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}
