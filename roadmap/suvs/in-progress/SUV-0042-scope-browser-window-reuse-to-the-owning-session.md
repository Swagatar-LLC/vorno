---
id: SUV-0042
title: Scope browser window reuse to the owning session
status: planned
plan: PLAN-047
direction: DIR-05
owner: jh
created: 2026-08-30
updated: 2026-08-30
related: [SUV-0041]
blocked-by: []
---

# SUV-0042 — Scope browser window reuse to the owning session

## Goal

A session re-binding a browser window across turns reclaims only *its own*
last window (the retained `ownerSessionId` edge) — never another session's
unbound leftover.

## Scope

- `apps/electron/src/main/browser-pane-manager.ts`:
  `findReusableUnboundInstance` matches on `ownerSessionId === sessionId`
  instead of "any unbound window in the workspace"; truly ownerless windows
  (`ownerSessionId === null`, user-opened) remain adoptable under the
  existing workspace rule.
- `createForSession` reuse path and its log line updated to state whose
  window was reclaimed.
- Out: the unbind-at-turn-end lifecycle itself (unchanged), remote BPM
  behavior, and any change to `bindSession` semantics.

## Acceptance

- [ ] With sessions A and B alternating turns in one workspace, B's
      `getOrCreateForSession` never returns A's unbound window (regression
      test reproduces today's cross-adoption, then passes).
- [ ] A session's second turn re-binds the same instance id as its first
      turn when that window is still alive.
- [ ] A user-opened window with no owner is still adoptable by a session in
      the same workspace (existing test stays green).
- [ ] `browser-pane-manager.test.ts` passes with the new cases.

## Status log

- `2026-08-30` — created in `planned/`
