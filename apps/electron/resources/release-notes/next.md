# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Workspace Pages foundation** — persistent local pages, sandboxed rendering, data refresh, and mediated action contracts are now available as the upstream compatibility baseline. Pages and publication remain unavailable by default in Vorno until the per-workspace authority and service boundaries land. (from upstream v0.13.3)

## Improvements

## Bug Fixes

- **Safer diagnostics redaction** — shared Sentry and diagnostic redaction now removes sensitive headers and breadcrumb fields consistently across main and renderer processes. (from upstream v0.13.3)

## Breaking Changes
