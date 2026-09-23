# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- New `ContextThresholdReached` automation event: fires once when an interactive session's context usage first crosses the workspace's warning threshold and once more at the danger threshold (Settings → AI → Token limits), so automations can react — for example, post a webhook or prompt a handoff. Matches on the level (`warn` / `danger`) and exposes `$CRAFT_LEVEL`, `$CRAFT_FRACTION`, `$CRAFT_USED_TOKENS`, and `$CRAFT_CONTEXT_WINDOW`.
## Improvements

## Bug Fixes

## Breaking Changes
