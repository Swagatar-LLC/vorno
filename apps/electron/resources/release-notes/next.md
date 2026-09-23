# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- New `ContextThresholdReached` automation event: fires once when an interactive session's context usage first crosses the workspace's warning threshold and once more at the danger threshold (Settings → AI → Token limits), so automations can react — for example, post a webhook or prompt a handoff. Matches on the level (`warn` / `danger`) and exposes `$CRAFT_LEVEL`, `$CRAFT_FRACTION`, `$CRAFT_USED_TOKENS`, and `$CRAFT_CONTEXT_WINDOW`.
- Automatic handoff on the context warning threshold (per workspace, off by default): when an interactive session first crosses its warning threshold, Vorno delivers your handoff prompt into it — skills mentioned as `[skill:slug]` or `@slug` are enabled — through the same mid-turn path as the composer, so the running turn is never interrupted. Once the handoff turn completes, an optional status is applied and the session can be archived. Stored under the workspace's `defaults.autoHandoff`; the settings card follows in the next release note.

## Improvements

- Settings → AI → Token limits gains an *Automatic handoff* card per workspace: enable it, edit the handoff prompt (with `[skill:slug]` or `@slug` mentions), choose a status to apply afterwards, and optionally archive the session once the handoff turn completes.
## Bug Fixes

## Breaking Changes
