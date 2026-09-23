---
id: SUV-0072
title: Auto-handoff on the warning threshold
status: done
plan: PLAN-055
direction: DIR-05
owner: jh
created: 2026-09-23
updated: 2026-09-23
related: [SUV-0071, SUV-0073, ADR-0021, PLAN-031]
blocked-by: []
---

# SUV-0072 — Auto-handoff on the warning threshold

## Goal

A per-workspace `defaults.autoHandoff` setting makes the session manager
deliver a configured handoff prompt (with `@skill` mentions) into an
interactive session on its first `warn` crossing, and apply a configured
status and optional archive once the handoff turn completes.

## Scope

- Schema: `WorkspaceConfig.defaults.autoHandoff = { enabled?, prompt?,
  status?, archive? }`; additive optional `WorkspaceSettings.autoHandoff` DTO;
  `SETTINGS_GET`/`SETTINGS_UPDATE` plumbing with validation (booleans, prompt
  length cap, `status` must be a configured status id).
- Consumer in `SessionManager`, beside the SUV-0071 emitter: on the first
  crossing at or above `warn` of an eligible session with the setting enabled
  and not yet fired, resolve `@mentions` to skill slugs (same resolver as
  automation prompts) and call `sendMessage(sessionId, prompt, …, { skillSlugs })`
  so delivery follows the connection's `midStreamBehavior` exactly like the
  composer. Persist `autoHandoffFiredAt` and a pending follow-through marker in
  `contextThresholdState`.
- Follow-through via `onSessionComplete` (queue empty, reason `complete`):
  `setSessionStatus(…, hostOrigin('auto-handoff'))` when a status is
  configured, then `archiveSession` when requested; clear the pending marker.
- A default prompt constant used when the configured prompt is blank.
- Out: settings UI (SUV-0073).

## Acceptance

- [x] `settings.test.ts` proves `autoHandoff` round-trips and that an unknown
      `status`, a non-boolean `enabled`/`archive`, or an over-long prompt is
      rejected.
- [x] A server-core test shows the prompt is sent exactly once per session with
      the mentioned skill slugs, is not sent when the setting is disabled or the
      session is ineligible, and the latch survives a header reload.
- [x] A server-core test shows status and archive are applied only after the
      completion event, including a closed-category status.
- [x] `apps/electron/resources/release-notes/next.md` gains a Features bullet.
- [x] Typecheck for `packages/shared`, `packages/server-core`, and
      `apps/electron` is clean.

## Status log

- `2026-09-23` — created in `planned/` (id allocated from the all-refs floor;
  see SUV-0071 for the refused reservation push).
- `2026-09-23` — moved from planned to in-progress (stacked on SUV-0071, PR #219)
- `2026-09-23` — moved from in-progress to done: `defaults.autoHandoff` schema,
  DTO and RPC validation (status must exist in the workspace), shared
  `auto-handoff` helpers (normalize, validate, default prompt, mention
  extraction for `[skill:slug]` and `@slug`), `maybeFireAutoHandoff` delivering
  through `sendMessage`, and `completeAutoHandoff` applying status (host
  origin) and archive on the queue-empty `complete` stop. Verified: 15 shared
  context-usage tests, 9 auto-handoff SessionManager tests, 13 settings RPC
  tests; `packages/shared` and `packages/server-core` typecheck clean.
