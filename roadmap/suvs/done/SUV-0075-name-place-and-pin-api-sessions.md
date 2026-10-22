---
id: SUV-0075
title: Name, place and pin API sessions
status: done
plan: PLAN-057
direction: DIR-03
owner: jh
created: 2026-10-21
updated: 2026-10-21
related: [SUV-0074]
blocked-by: []
---

# SUV-0075 — Name, place and pin API sessions

## Goal

Let `POST /api/sessions` set a desktop-routed session's `name`, `projectId` and
`llmConnection`, and return 400 for a `model` the resolved connection does not
offer instead of silently falling back.

## Scope

- `apps/server`: `routes/sessions.ts` validation; `HostCreateSessionOptions` fields.
- `apps/electron` main: `desktop-sessions.ts` passes the fields to `SessionManager.createSession`.
- Docs: `docs/http-trigger-server.md`, `apps/server/README.md`.
- Out: the headless pool, which rejects the new fields with 400.

## Acceptance

- [x] `cd apps/server && bun test` passes with cases for unknown project, unknown connection, unavailable model and pool rejection.
- [x] Electron main tests show `name`, `projectId` and `llmConnection` reach `SessionManager.createSession`.
- [x] Docs describe the three fields and the 400 cases.

## Status log

- `2026-10-21` — created in `planned/`
- `2026-10-21` — moved from planned to in-progress
- `2026-10-21` — moved from in-progress to done: merged in #241; release notes in 0.22.0-beta.12
