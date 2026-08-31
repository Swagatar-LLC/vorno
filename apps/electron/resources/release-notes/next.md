# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- Per-session browser isolation: each agent session's browser window now has its own private storage partition (cookies, logins, storage), so concurrent sessions can hold different logins on the same site. Manual windows keep the shared partition. Note: session browsers start logged out.
- Idle browser window reaping: hidden, unbound session browser windows are destroyed after a per-workspace idle TTL (Workspace Settings → Advanced, default 60 minutes, 0 disables). User-opened windows are never reaped.

## Improvements

- Browser windows are session-sticky across turns: a session re-binds the same window it used last turn and never adopts another session's window.

## Bug Fixes

- Commands against a closed browser window now return a clear "Browser window was closed" error instead of Electron's raw "Object has been destroyed" or "[object Object]".

## Breaking Changes
