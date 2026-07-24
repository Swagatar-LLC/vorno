# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- Web UI over an HTTPS reverse proxy (e.g. Tailscale) no longer fails to log in or connect — the WebSocket now uses `wss://` to match the page, avoiding mixed-content blocking
- Web UI login password now persists reliably across restarts, and you can set your own password in Settings → Remote Access instead of only regenerating one
- Web UI Tailscale secure tunnel now supports a configurable HTTPS port (not just 443) and reliably removes its serve rule on stop/quit

## Breaking Changes
