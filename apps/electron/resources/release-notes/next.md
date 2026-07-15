# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- Remote WebUI access now works through a single port. The WebSocket connection is proxied through the same port the page loads from, so reaching the app from another device (phone, tablet, another computer) only needs one port opened.
- Added a clear connection-error screen. When the app can't reach its backend, it now shows a "can't reach your instance" message with a Retry button instead of dropping you into the first-run setup walkthrough.
- Web UI bind address is now selectable in Remote Access settings — choose `127.0.0.1` (localhost only) or `0.0.0.0` (all interfaces), with the same network-exposure warning as the trigger server. A hand-edited interface IP is preserved and shown as a custom option.

## Improvements

## Bug Fixes

## Breaking Changes
