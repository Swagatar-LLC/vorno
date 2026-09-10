---
id: SUV-0055
title: Harden packaged CLI install and runtime smoke
status: in-progress
plan: PLAN-049
direction: DIR-03
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: []
blocked-by: []
---

# SUV-0055 — Harden packaged CLI install and runtime smoke

## Goal

Make the standalone CLI install and packaged launcher path verifiable from the monorepo root without claiming untested native-platform packaging.

## Scope

- Preserve the caller working directory while resolving the packaged binary from its resource directory.
- Add a shell-independent current-platform installer, with an explicit destination override for automation.
- Add CI coverage that compiles, installs, and invokes the packaged launcher, and statically verifies every platform build script retains its compile-and-validate contract.
- Do not claim native Windows or Linux Electron distribution smoke coverage.

## Acceptance

- [x] `bun run cli:install` chooses a platform-safe default destination and supports `VORNO_CLI_INSTALL_DIR`.
- [x] The packaged POSIX launcher runs the compiled CLI from a monorepo-root invocation and preserves the caller directory for CLI project-local defaults.
- [x] CI runs the compiled install and launcher smoke and verifies the macOS, Linux, and Windows platform build-script contracts.
- [x] CLI typecheck and unit tests pass.

## Status log

- `2026-09-10` — created in `planned/`.
- `2026-09-10` — moved from `planned` to `in-progress`: implementing and validating the packaged CLI delivery path.
