---
id: SUV-0071
title: Emit ContextThresholdReached from the session manager
status: in-progress
plan: PLAN-055
direction: DIR-05
owner: jh
created: 2026-09-23
updated: 2026-09-23
related: [PLAN-003, PLAN-030, SUV-0072, SUV-0073]
blocked-by: []
---

# SUV-0071 — Emit ContextThresholdReached from the session manager

## Goal

The session manager detects the first `warn` and first `danger` crossing of an
interactive session's context usage, using the workspace's PLAN-003
thresholds, and emits a new `ContextThresholdReached` automation app event.

## Scope

- Move the pure threshold math (`resolveThresholds`, `computeContextUsage`,
  `isValidThresholds`) into a browser-safe `@craft-agent/shared/context-usage`
  module; `apps/electron/src/renderer/components/chat/context-usage.ts`
  re-exports it so renderer imports and tests are unchanged.
- `SESSION_PERSISTENT_FIELDS` gains `contextThresholdState` (first-crossing
  timestamps per level plus handoff markers reserved for SUV-0072), typed on
  `SessionConfig` / `SessionHeader`.
- `SessionManager` observes `usage_update` and `complete`, resolves
  `(providerType, model)` thresholds and the context window (session-reported,
  falling back to the model registry), and on a first crossing persists the
  latch and emits `ContextThresholdReached` on the workspace automation bus.
  Hidden, Tasks Conductor (`taskSlug`), and automation-created (`triggeredBy`)
  sessions are excluded.
- The event end to end: shared `AppEvent`/`APP_EVENTS`, payload type, match
  value (the level), renderer `AppEvent`/`APP_EVENTS`/display name/category,
  and the automations doc tables (event row and `CRAFT_*` variables).
- Out: the auto-handoff setting and consumer (SUV-0072), the settings UI
  (SUV-0073).

## Acceptance

- [ ] `bun test packages/shared` covers `getMatchValue('ContextThresholdReached')`
      and the moved `context-usage` module; the renderer's existing
      `context-usage*.test.ts` still pass unchanged.
- [ ] A server-core test drives `usage_update` samples through the watcher and
      shows exactly one `warn` and one `danger` crossing per session, none for a
      hidden / `taskSlug` / `triggeredBy` session, and none when the window is
      unknown.
- [ ] The latch is written to the session header and a reloaded session does not
      re-emit.
- [ ] `apps/electron/resources/docs/automations.md` lists the event and its
      `$CRAFT_LEVEL`, `$CRAFT_FRACTION`, `$CRAFT_USED_TOKENS`,
      `$CRAFT_CONTEXT_WINDOW` variables; renderer shows it as
      "Context Threshold Reached" under event-based automations.
- [ ] Typecheck for `packages/core`, `packages/shared`, `packages/server-core`,
      and `apps/electron` is clean.

## Status log

- `2026-09-23` — created in `planned/`. The `refs/suv-ids/` reservation push
  for SUV-0071–0073 was refused (HTTP 403: this session's push credential is
  scoped to `claude/*` branches), so the ids were allocated from the all-refs
  floor (`SUV-0070`) without a published claim.
- `2026-09-23` — moved from planned to in-progress
