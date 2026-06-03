// The container-isolation toggle, shared by `loom run` / `loom daemon` /
// `loom serve`.
//
// One place decides — given the `--docker` / `--no-docker` toggle, a Docker
// probe, and the deployment env — whether a drive runs each spawn inside a
// container (the isolation fence that makes `bypassPermissions` safe) or in a
// bare git worktree (the honest-but-thin default). It encodes the honesty
// rule: claim only the isolation actually provided. `auto` prefers Docker and
// falls back to the worktree with a LOUD notice; `--docker` REQUIRES it and
// refuses cleanly when Docker / an image / a credential is missing;
// `--no-docker` forces the worktree even when Docker is present.
//
// It never imports docker or @loomfsm/driver — it returns a plain plan the
// command turns into a `createContainerExecutor` call.

import { existsSync } from "node:fs";
import { join } from "node:path";

// Resolved from the toggle flags. `auto` is the default (prefer Docker, else
// worktree + notice); `require` is `--docker` (no fence, no run); `off` is
// `--no-docker` (force worktree).
export type ContainerMode = "auto" | "require" | "off";

export function containerModeFrom(opts: { docker: boolean; noDocker: boolean }):
  | { mode: ContainerMode }
  | { error: string } {
  if (opts.docker && opts.noDocker) {
    return { error: "--docker and --no-docker are mutually exclusive" };
  }
  if (opts.docker) return { mode: "require" };
  if (opts.noDocker) return { mode: "off" };
  return { mode: "auto" };
}

// The headless credential the in-container `claude -p` authenticates with: a
// subscription OAuth token (preferred, cross-platform) or, on a host that
// stores file credentials, a read-only `.credentials.json` mount.
export type ContainerCreds =
  | { kind: "token"; token: string }
  | { kind: "file"; path: string }
  | { kind: "none" };

export function resolveContainerCreds(env: NodeJS.ProcessEnv, home: string): ContainerCreds {
  const token = env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (token !== undefined && token.length > 0) return { kind: "token", token };
  const credPath = join(home, ".claude", ".credentials.json");
  if (existsSync(credPath)) return { kind: "file", path: credPath };
  return { kind: "none" };
}

// The subset of container-executor options the toggle resolves (the rest —
// project_dir, signal, onNotice, onUsage — the command supplies).
export interface ContainerSettings {
  image: string;
  network?: string;
  user?: string;
  strict_mcp?: boolean;
  max_turns?: number;
  oauth_token?: string;
  cred_file?: string;
}

export type ContainerPlan = { useDocker: false } | { useDocker: true; container: ContainerSettings };

export interface ResolvePlanArgs {
  mode: ContainerMode;
  env: NodeJS.ProcessEnv;
  home: string;
  dockerAvailable: () => boolean;
  // Loud-notice sink — the fallback / active-fence messages go here.
  onNotice: (message: string) => void;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.length > 0 ? v : undefined;
}

// Decide worktree vs container and gather the container settings. Throws (with
// a clear message) only in `require` mode when Docker / an image / a credential
// is missing; in `auto` it degrades to the worktree with a loud notice.
export function resolveContainerPlan(args: ResolvePlanArgs): ContainerPlan {
  if (args.mode === "off") return { useDocker: false };

  const fallback = (why: string): ContainerPlan => {
    if (args.mode === "require") {
      throw new Error(`--docker requires container isolation, but ${why}`);
    }
    args.onNotice(
      `${why}; falling back to git-worktree isolation (no container fence). ` +
        `Pass --no-docker to silence this, or see the container docs to enable it.`,
    );
    return { useDocker: false };
  };

  if (!args.dockerAvailable()) {
    return fallback("the Docker CLI was not found or its daemon is unreachable");
  }
  const image = nonEmpty(args.env["LOOM_DOCKER_IMAGE"]);
  if (image === undefined) {
    return fallback("no container image is set (LOOM_DOCKER_IMAGE)");
  }
  const creds = resolveContainerCreds(args.env, args.home);
  if (creds.kind === "none") {
    return fallback(
      "no headless credential is available (run 'claude setup-token' and set CLAUDE_CODE_OAUTH_TOKEN)",
    );
  }

  const container: ContainerSettings = { image };
  const network = nonEmpty(args.env["LOOM_DOCKER_NETWORK"]);
  if (network !== undefined) container.network = network;
  // Set even when "" — an empty value means "omit --user, trust the image USER".
  if (args.env["LOOM_DOCKER_USER"] !== undefined) container.user = args.env["LOOM_DOCKER_USER"];
  if (nonEmpty(args.env["LOOM_DOCKER_STRICT_MCP"]) !== undefined) container.strict_mcp = true;
  const maxTurns = Number(args.env["LOOM_CLAUDE_MAX_TURNS"]);
  if (Number.isInteger(maxTurns) && maxTurns > 0) container.max_turns = maxTurns;
  if (creds.kind === "token") container.oauth_token = creds.token;
  if (creds.kind === "file") container.cred_file = creds.path;

  // Honesty: state exactly what isolation is in force.
  args.onNotice(
    `container isolation active (image ${image}, ${creds.kind} credential) — ` +
      `bypassPermissions runs behind the container fence.`,
  );
  return { useDocker: true, container };
}

// Per-spawn usage → a one-line audit string. Shared so the cost figure reads
// identically across `run` / `daemon` / `serve` log sinks.
export function formatUsage(usage: {
  tokens?: { in: number; out: number; cached?: number };
  cost_usd?: number;
  num_turns?: number;
}): string {
  const parts: string[] = [];
  if (usage.cost_usd !== undefined) parts.push(`cost $${usage.cost_usd.toFixed(4)}`);
  if (usage.tokens !== undefined) {
    const { in: i, out, cached } = usage.tokens;
    parts.push(`tokens ${i}in/${out}out${cached !== undefined ? `/${cached}cached` : ""}`);
  }
  if (usage.num_turns !== undefined) parts.push(`${usage.num_turns} turns`);
  return parts.length > 0 ? `spawn usage — ${parts.join(", ")}` : "spawn usage — (none reported)";
}
