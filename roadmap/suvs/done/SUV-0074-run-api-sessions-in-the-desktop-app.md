---
id: SUV-0074
title: Run API sessions in the desktop app
status: done
plan: PLAN-057
direction: DIR-03
owner: jh
created: 2026-10-21
updated: 2026-10-21
related: [ADR-0007]
blocked-by: []
---

# SUV-0074 — Run API sessions in the desktop app

## Goal

Ship the opt-in Remote Access setting that routes REST-created sessions through
the desktop SessionManager via `HostBridge.createSession`.

## Scope

- `apps/server`: `routeSessionsToDesktop` config flag; `RoutedSession` adapter;
  `SessionPool.adopt`; routes choose host vs pool; ownership on `/:id` routes.
- `apps/electron` main: SessionManager-backed `createSession` in the embedded
  host; session-event tap; supervisor config plumbing.
- `apps/electron` renderer: toggle in `RemoteAccessSettingsPage.tsx`, i18n keys
  in every locale.
- Docs: `docs/http-trigger-server.md` section with a placeholder-only curl recipe.
- Out: WebSocket session protocol; standalone server behavior.

## Acceptance

- [x] `cd apps/server && bun test` passes with route-through cases for flag on, flag off, and no host seam.
- [x] Policy mapping and permission routing are covered by tests (allow-all, allow-safe, deny-all).
- [x] Electron main tests cover the SessionManager adapter and event translation.
- [x] A test shows `browser_tool` throws without `browserPaneFns` and runs with them.
- [x] `typecheck:ci`, electron typecheck, lint and the i18n gates pass.
- [x] Docs carry the curl check with placeholders only.

## Status log

- `2026-10-21` — created in `planned/`
- `2026-10-21` — moved from planned to in-progress
- `2026-10-21` — moved from in-progress to done: merged in #238; release notes in 0.22.0-beta.11
