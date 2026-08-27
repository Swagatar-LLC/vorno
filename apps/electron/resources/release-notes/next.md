# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Headroom context management, per workspace.** Workspace settings gain a Headroom section with a master switch, compression engine preferences, verbosity steering, and a statistics toggle. Settings inherit from instance defaults unless the workspace overrides them, and each value shows which of the two it came from. Off by default.
- **View the original behind any compressed tool output.** Compressed turns carry a badge showing what was saved; clicking it retrieves and displays the original content. When retrieval is not possible, the reason is stated plainly — Headroom off, service unreachable, or the content no longer held — rather than failing silently.
- **A Headroom savings report.** A new report shows tokens before and after, tokens saved, items compressed, and originals retrieved, scoped to either the current session or the whole workspace. Every figure is measured and read from Headroom itself; anything Headroom does not report is shown as unknown rather than estimated or interpolated.

## Improvements

## Bug Fixes

## Breaking Changes
