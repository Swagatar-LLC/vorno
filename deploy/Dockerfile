# =============================================================================
# VORNO trigger server (apps/server) — headless deployment image (PLAN-013)
#
# This is the LEAN image for the fork's HTTP trigger surface + standalone
# headless host. It deliberately does NOT build the WebUI or the WhatsApp worker
# (those belong to packages/server; see the repo-root Dockerfile.server). It does
# install Node.js alongside Bun because the Claude Agent SDK spawns a subprocess
# out of node_modules.
#
# Build (from the repo root, NOT from deploy/):
#   docker build -f deploy/Dockerfile -t vorno-server .
#
# Run:
#   see deploy/compose.yaml (primary) or deploy/systemd/ (bare-metal alternative)
# =============================================================================

FROM oven/bun:1.3-slim

LABEL org.opencontainers.image.source="https://github.com/Swagatar-LLC/craft-agents-oss"
LABEL org.opencontainers.image.description="VORNO trigger server (apps/server) — headless AI trigger + automation host"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# System deps + Node.js (Claude Agent SDK subprocess). Pin Node via NodeSource so
# upgrades are explicit. ripgrep/git are commonly needed by agent tools.
ARG NODE_MAJOR=20
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates git ripgrep curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Non-root service user (the Claude Code SDK refuses to run as root). HOME anchors
# ~/.claude (the SDK's native resume store — ADR-0005 §4: never re-keyed).
RUN groupadd -r vorno && \
    useradd -r -g vorno -m -d /home/vorno -s /bin/bash vorno

WORKDIR /app

# Copy the full monorepo, then install. bunfig.toml (linker config) and bun.lock
# are included by the copy. We intentionally forgo per-manifest dependency-layer
# caching in favor of robustness: the workspace member list drifts over time, and
# a stale COPY list silently breaks `--frozen-lockfile`. The .dockerignore at the
# repo root strips node_modules, build outputs, and tests from the context.
COPY . .
RUN bun install --frozen-lockfile

# CONFIG_DIR lives on a mounted volume (see compose). Pre-create it owned by the
# service user so a fresh Docker named volume inherits the right ownership.
RUN mkdir -p /data/vorno-agent && chown -R vorno:vorno /data /app /home/vorno

USER vorno

# ADR-0005: in the container we use the documented CRAFT_CONFIG_DIR escape hatch
# to point at the named volume — explicit beats guessing the container HOME.
ENV CRAFT_CONFIG_DIR=/data/vorno-agent
# Bind all interfaces inside the container; compose maps it to 127.0.0.1 on the
# host. These are non-secret overrides (PLAN-013 work item 4).
ENV CRAFT_TRIGGER_HOST=0.0.0.0
ENV CRAFT_TRIGGER_PORT=3847
# Compose the in-process headless SessionManager + AutomationSystem (PLAN-013).
ENV CRAFT_STANDALONE=1

EXPOSE 3847

ENTRYPOINT ["bun", "run", "apps/server/src/index.ts"]
