# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

## Improvements

## Bug Fixes

## Breaking Changes

## Improvements

- Added opt-in decision-model controls for Guarded permissions, turn outcomes, adaptive thinking, mid-turn message handling, titles, suggestions, large results and automation conditions. They remain off by default. Remote decision settings now address the host that runs the selected workspace, across that host's workspaces. (from upstream v0.14.0)
- Added decision-assisted task verdicts and repair selection, semantic label rules, and decision usage reporting. (from upstream v0.14.0)

## Bug fixes

- Tightened read-only command detection, remembered permission scopes and spawned-session permission ceilings. (from upstream v0.14.0)
- Preserved queued-message crash recovery across decision-driven steering and merged continuations. Automation history distinguishes skipped conditions from executions.
- Large Claude MCP results now pass through a pre-model guard. Removed redundant summarization of the displayed result copy; existing Headroom event compression and retrieval remain unchanged. (from upstream v0.14.0)

- Guarded file writes now resolve symlinks before allowing project-local writes, and fall back to Ask if the feature turns off during a risk check. Automation failure-handler sessions retain their matcher identity and chain depth. Late title and semantic-label decisions no longer write after shutdown.
