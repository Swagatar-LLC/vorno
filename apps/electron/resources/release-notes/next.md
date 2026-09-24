# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

## Improvements

- Agents now receive a dedicated developer-context system prompt (from upstream v0.13.4).

## Bug Fixes

- Multiple mid-turn steers are delivered in order instead of the last one winning (from upstream v0.13.4).
- The context-usage and compaction indicator now reports the real remaining context (from upstream v0.13.4).
- The mobile web composer no longer breaks when the on-screen keyboard resizes the viewport (from upstream v0.13.4).

## Breaking Changes
