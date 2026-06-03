# Reference image for loom's container-isolation backend (`loom run --docker`,
# `loom daemon --docker`, `loom serve --docker`).
#
# loom runs each spawn as `claude -p` INSIDE a container so a full-power
# (bypassPermissions) agent is fenced to a mounted clone of the project — not
# the host filesystem. The image needs only the Claude Code CLI and git; loom
# supplies the clone mount, a writable tmpfs HOME, the subscription credential
# (via CLAUDE_CODE_OAUTH_TOKEN), and runs the container as a non-root user.
#
# Build:  docker build -t loom-claude:latest docker/
# Use:    export LOOM_DOCKER_IMAGE=loom-claude:latest
#
# Note: Claude Code's full-bypass mode refuses to run as root, so the image must
# NOT default to the root user — loom passes `--user <host-uid>:<gid>` and a
# writable tmpfs HOME, which works regardless of the image's own USER.

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /workspace
