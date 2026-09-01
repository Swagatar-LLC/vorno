---
id: SUV-0043
title: Alive-guard remaining instance paths and fix destroyed-window error text
status: done
plan: PLAN-047
direction: DIR-05
owner: jh
created: 2026-08-30
updated: 2026-08-31
related: []
blocked-by: []
---

# SUV-0043 — Alive-guard remaining instance paths and fix destroyed-window error text

## Goal

Operations against a destroyed browser window always surface as a clear
"Browser window was closed" tool error — never Electron's raw
"Object has been destroyed" or a `[object Object]` serialization.

## Scope

- `apps/electron/src/main/browser-pane-manager.ts`: route the remaining raw
  `getInstance` consumers (notably the capability-invoke `getInstance` /
  action cases) through `requireAliveInstance`; guard event-handler and
  in-flight async paths that can touch views mid-teardown.
- `packages/shared/src/agent/browser-tools.ts` error path: stringify
  non-`Error` rejections usefully (message extraction / JSON fallback)
  instead of `String(error)` → `[object Object]`.
- Out: changing when windows are destroyed (lifecycle is SUV-0044),
  and popup-window lifecycle beyond what the guards touch.

## Acceptance

- [x] Destroying a window while a command is dispatched against it returns
      the "Browser window was closed (instance: …)" error (test).
- [x] No call site in `browser-pane-manager.ts` invokes `webContents`/view
      methods on an instance obtained without an alive check (survey listed
      in the PR description).
- [x] A rejected non-`Error` value produces a readable tool error message
      (test at the browser-tools layer).
- [x] `browser-pane-manager.test.ts` and shared package tests pass.

## Status log

- `2026-08-30` — created in `planned/`
- `2026-08-31` — moved from planned to in-progress: implementation started (session 260831-high-cascade)
- `2026-08-31` — moved from in-progress to done: shipped in PR #189 (merge 047cb286); gate = two-session OpenAI Sol adversarial review (fan-in in PR #189 comments), all findings addressed in af0859bc
