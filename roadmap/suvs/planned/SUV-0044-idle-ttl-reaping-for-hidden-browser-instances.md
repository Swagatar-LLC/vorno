---
id: SUV-0044
title: Idle TTL reaping for hidden browser instances
status: planned
plan: PLAN-047
direction: DIR-05
owner: jh
created: 2026-08-30
updated: 2026-08-30
related: []
blocked-by: []
---

# SUV-0044 — Idle TTL reaping for hidden browser instances

## Goal

Hidden, unbound session-owned browser windows are destroyed after a
per-workspace idle TTL instead of accumulating for the life of the app.

## Scope

- Reuse the PLAN-038 idle-sweep pattern: a minute tick in the Electron main
  process destroys instances that are hidden, unbound
  (`boundSessionId === null`), session-owned, and idle past the TTL.
- Quiescence guards: never reap a visible window, a bound window, or one
  with in-flight network activity/downloads.
- Per-workspace TTL setting on the existing `workspaceSettings:*` surface
  (default aligned with `idleAgentTtlMinutes` semantics; `0` = never).
- Manual windows are exempt entirely.
- Out: on-disk partition data cleanup (retention untouched), and any change
  to the close-intercepts-to-hide behavior for live windows.

## Acceptance

- [ ] A hidden unbound session window is destroyed after the TTL elapses;
      the sweep log names the instance and reason (test with fake timers).
- [ ] Bound, visible, or active-download windows survive the sweep (tests).
- [ ] TTL `0` disables reaping; manual windows are never reaped (tests).
- [ ] Setting is readable/editable via the existing per-workspace settings
      surface with no new IPC channels.

## Status log

- `2026-08-30` — created in `planned/`
