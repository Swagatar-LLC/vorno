# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Workspace Pages foundation** — persistent local pages, sandboxed rendering, data refresh, and mediated action contracts are present as an upstream compatibility baseline. Pages and publication remain unavailable by default in Vorno until the per-workspace authority and service boundaries land. (from upstream v0.13.0–v0.13.3)
- **Expanded model catalog** — upstream additions include Claude Fable 5.1 across Anthropic and Bedrock profiles, GPT-6 Astra for OpenAI connections, and newer Pi-provider model families. Vorno retains its existing connection defaults. (from upstream v0.13.1–v0.13.3)

## Improvements

- **More resilient Pi conversations** — upstream retry/recovery work keeps eligible transient provider failures open with visible backoff progress, discards failed partial output, and bounds utility-query execution. (from upstream v0.13.3)
- **Updated Claude and Pi SDKs** — upstream SDK updates add improved usage/cost reporting, MCP resource links, model catalog coverage, and streaming/recovery fixes. (from upstream v0.13.1–v0.13.3)

## Bug Fixes

- **Safer diagnostics redaction** — shared Sentry and diagnostic redaction now removes sensitive headers and breadcrumb fields consistently across main and renderer processes. (from upstream v0.13.3)
- **Clearer CLI failures** — upstream CLI runs now preserve structured provider errors, return nonzero exit status on failure, and mark discarded partial output explicitly. (from upstream v0.13.3)

## Breaking Changes
