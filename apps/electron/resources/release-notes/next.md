# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- Optional decision model for classification and scoring. Configure Jev with a supported hosted provider or a local server in AI settings. The `decide` tool remains disabled until you enable the integration; its results do not grant permissions. (from upstream v0.13.6)

## Improvements

## Bug Fixes

- Messages sent during Pi compaction queue for replay instead of disappearing. Browser teardown recovers after popup windows close. (from upstream v0.13.6)
- API source tests and runtime calls share header-credential parsing, and MCP OAuth supports resource-bound servers. Slack desktop sign-in retains Vorno relay handling. (from upstream v0.13.6)
- ChatGPT title generation falls back when a utility model is unavailable. Saved connection tests reuse stored credentials, and transcript paths remain correct when the app starts from Finder. (from upstream v0.13.6)
- Configuration overrides apply across app state paths, allowed write paths work in Ask to Edit, and interceptor debug logs rotate without request bodies by default. Vorno retains its isolated config and credential migration rules. (from upstream v0.13.6)
- MCP connection failures are visible and connect in parallel. Pi warns when reasoning consumes the output budget without producing text. (from upstream v0.13.6)

## Breaking Changes
