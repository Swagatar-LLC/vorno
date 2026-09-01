---
id: SUV-0042
title: Scope browser window reuse to the owning session
status: done
plan: PLAN-047
direction: DIR-05
owner: jh
created: 2026-08-30
updated: 2026-08-31
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

- [x] With sessions A and B alternating turns in one workspace, B's
      `getOrCreateForSession` never returns A's unbound window (regression
      test reproduces today's cross-adoption, then passes).
- [x] A session's second turn re-binds the same instance id as its first
      turn when that window is still alive.
- [x] A user-opened window with no owner is still adoptable by a session in
      the same workspace (existing test stays green).
- [x] `browser-pane-manager.test.ts` passes with the new cases.

## Status log

- `2026-08-30` — created in `planned/`
- `2026-08-31` — moved from planned to in-progress: implementation started (session 260831-high-cascade)
- `2026-08-31` — moved from in-progress to done: shipped in PR #189 (merge 047cb286); gate = two-session OpenAI Sol adversarial review (fan-in in PR #189 comments), all findings addressed in af0859bc
