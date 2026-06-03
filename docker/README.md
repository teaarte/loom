# Container isolation for loom

loom's headless backends (`loom run`, `loom daemon`, `loom serve`) can run each
`claude -p` spawn **inside a container** instead of a bare git worktree. The
container is the isolation boundary: it mounts only a dedicated clone of the
project plus the one credential needed to sign in, so a full-power
(`bypassPermissions`) agent is fenced away from the host filesystem, your other
repositories, and your credentials. That fence is what makes "set it and forget
it" autonomy safe to leave running.

## Quick start

```bash
# 1. Build the reference image (Claude Code CLI + git).
docker build -t loom-claude:latest docker/

# 2. Mint a long-lived SUBSCRIPTION token (not an API key) and point loom at the image.
export LOOM_DOCKER_IMAGE=loom-claude:latest
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"

# 3. Run fenced.
loom run --docker "add a health check route"
loom daemon start --docker --watch
```

## The toggle

| Flag          | Behavior                                                                 |
|---------------|--------------------------------------------------------------------------|
| *(none)*      | **auto** — use the container if Docker is available, else fall back to the git worktree with a loud notice. |
| `--docker`    | **require** — refuse cleanly if Docker, an image, or a credential is missing (no fence, no run). |
| `--no-docker` | force the git worktree even when Docker is present.                      |

loom claims only the isolation it actually provides: with no Docker it says so
and degrades — it never runs unsandboxed while implying a sandbox.

## Environment

| Variable                   | Meaning                                                                 |
|----------------------------|-------------------------------------------------------------------------|
| `LOOM_DOCKER_IMAGE`        | **Required for container mode.** An image with the Claude Code CLI + git. |
| `CLAUDE_CODE_OAUTH_TOKEN`  | Subscription token from `claude setup-token` (preferred, cross-platform). Forwarded into the container by name — never placed on the command line. |
| `LOOM_DOCKER_NETWORK`      | `docker run --network` value. Default: Docker's bridge (outbound only — egress is required to reach the model API). |
| `LOOM_DOCKER_USER`         | `docker run --user` value. Default: the host `uid:gid` (files land host-owned, and non-root so bypass is allowed). Set empty to trust the image's own non-root `USER`. |
| `LOOM_CLAUDE_MAX_TURNS`    | Cap on agentic turns per spawn.                                          |
| `LOOM_DOCKER_BIN`          | The `docker` binary name. Default `docker`.                             |

On a host that stores file credentials (`~/.claude/.credentials.json`, e.g.
some Linux setups), loom mounts that file read-only as a fallback when no token
env is set. macOS keeps the credential in the Keychain, which a container
cannot read — use `CLAUDE_CODE_OAUTH_TOKEN` there.

## How the work comes back

The agent operates on a `git clone --local` of your project (full git inside the
fence), so your live checkout is never mounted. On completion, the supervisor
extracts the agent's work to a `loom/<task>` branch in your real repository —
reviewable, **never** auto-merged into your checked-out branch — and removes the
clone.

## Bringing your own image

Any image works as long as it provides `claude` (the Claude Code CLI) and `git`
on `PATH`. loom runs the container non-root with a writable tmpfs HOME, so the
image does not need to pre-create a home directory.
