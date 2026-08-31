---
id: SUV-0041
title: Per-session storage partition for session-owned browser windows
status: in-progress
plan: PLAN-047
direction: DIR-05
owner: jh
created: 2026-08-30
updated: 2026-08-31
related: [SUV-0042]
blocked-by: []
---

# SUV-0041 — Per-session storage partition for session-owned browser windows

## Goal

Session-owned browser windows are created on `persist:browser-pane-<sessionId>`
instead of the shared `persist:browser-pane`, so each session's cookies,
logins, and storage are private to it.

## Scope

- `apps/electron/src/main/browser-pane-manager.ts`: `createInstance` derives
  the partition name from `ownerSessionId` when `ownerType === 'session'`;
  manual windows keep `persist:browser-pane` unchanged.
- Per-partition permission/observer setup: `partitionPermissionsInitialized` /
  `partitionObserversInitialized` become per-partition-name tracking so each
  new partition gets `setupSessionPermissions`/`setupSessionObservers` exactly
  once.
- Out: cookie seeding / auth hand-off from the manual browser (PLAN-047
  non-goal), partition cleanup on session deletion (falls to SUV-0044's
  lifecycle story only insofar as window destruction; on-disk partition data
  retention is deliberately untouched here).

## Acceptance

- [ ] A cookie set in session A's browser window is not visible in session B's
      window or in a manual window, and vice versa (test drives two instances
      with different `ownerSessionId`s).
- [ ] Manual windows still share `persist:browser-pane` (existing behavior
      test unchanged/green).
- [ ] Permission handlers and observers fire for windows on a fresh
      per-session partition (test or assertion on per-partition init).
- [ ] `browser-pane-manager.test.ts` passes with the new cases.

## Status log

- `2026-08-30` — created in `planned/`
- `2026-08-31` — moved from planned to in-progress: implementation started (session 260831-high-cascade)
