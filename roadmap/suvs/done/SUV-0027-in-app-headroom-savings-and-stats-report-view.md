---
id: SUV-0027
title: In-app Headroom savings and stats report view
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related:
  - SUV-0026-user-visible-retrieval-of-compressed-originals.md (per-item affordance; this SUV is the aggregate view)
blocked-by:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (there are no real stats to report until compression runs)
---

# SUV-0027 — In-app Headroom savings and stats report view

## Goal

Give the app a Headroom report view where the user can see measured token
savings and compression stats — per session and aggregated per workspace —
read through the boundary adapter's stats operation.

## Scope

- A report surface in `apps/electron` (reachable from the workspace, and from
  a session for that session's slice) showing: tokens before/after, savings,
  items compressed, and retrievals — sourced from `adapter.stats()` only.
- "Measured or absent" is the rendering contract: a stat the adapter does not
  report renders as unknown/absent — never zeros, estimates, or interpolation.
- Deliberately out: token *budget* displays and thresholds (SUV-0028 — those
  are the PLAN-002/003 surfaces), and memory stats (I2).

## Acceptance

- [x] A Headroom report view exists showing per-session and per-workspace stats (tokens before/after, savings, compressed-item count, retrieval count), and every figure traces to `adapter.stats()` — no computation of savings outside the adapter.
- [x] Stats the adapter reports as absent render as unknown/absent; a test feeds a stats payload with missing fields and asserts no zeros or estimates appear.
- [x] With Headroom disabled or the no-op adapter active, the view states that no stats are available rather than showing an empty chart of zeros.
- [x] The view updates to reflect a newly completed session's stats without an app restart.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — **done.** Shipped on `plan/plan-040`.

  **The problem nobody had solved yet.** `SdkHeadroomAdapter.stats()` reports the
  *service's* cumulative counters — every session, every workspace, every other
  client of the same proxy. Rendering those as "this session saved N tokens"
  would be a real measurement of the wrong thing, so per-scope counting had to
  exist before a report could. It is built as two more implementations of the
  same contract (`packages/shared/src/headroom/scoped-adapter.ts`):
  `createScopedHeadroomAdapter` wraps a session's adapter and counts what passes
  through it; `createAggregateHeadroomAdapter` sums the scopes underneath it.
  Making the scoping an *adapter* is what keeps "no computation of savings
  outside the adapter" literally true — every layer above moves an opaque
  measurement around and does no arithmetic at all.

  **Wiring.** `createSessionHeadroomAdapter` now returns the scoped wrapper, so
  every session's `stats()` answers for that session (delegation is exact —
  same `kind`, same result objects, including the no-op adapter's
  identical-`messages` promise). `buildHeadroomStatsReport` picks which adapter
  answers for which scope and is the one place `exposeStats` is honoured —
  SUV-0016 shipped that field with this meaning and nothing had read it until
  now; the gate is server-side so a workspace that turned it off keeps the
  numbers off the wire entirely. `SessionManager.getHeadroomStatsReport`
  collects the live agents' adapters; `vorno:headroom:stats:get` returns the
  report and `vorno:headroom:stats:changed` (ids only, no numbers) fires from
  `emitSessionComplete`.

  **The view** is `HeadroomReportSection`, mounted in Workspace Settings
  (workspace aggregate) and in `SessionInfoPopover` (that session's slice) — the
  same component, `sessionId` the only difference. `Number` formatting is its
  whole job: an omitted field renders `—`, an absent measurement renders one
  sentence saying *why* (off / not available / nothing compressed yet) and no
  table at all.

  **Types.** `HeadroomUsageStats` gained an optional `retrievals` and made
  `averageCompressionRatio` / `cacheHits` optional, so an implementation that
  cannot measure a field omits it instead of writing a zero. The SDK adapter's
  strict reader is unchanged. New `HeadroomStatsReport` in
  `packages/core/src/types/headroom-report.ts`.

  **Red-then-green, observed.** Deriving `tokensSaved` from `before - after` in
  the view model and defaulting `retrievals` to `0` turned two acceptance tests
  red (`renders the adapter's savings figure, never one derived from
  before/after`; `leaves omitted fields with no value and prints no zeros`);
  dropping the re-fetch from `watchHeadroomReport` turned three live-refresh
  tests red. Both reverted to green.

  **Suites:** `packages/shared` 3609 pass / 0 fail · `apps/server` 196 / 0 ·
  `bun run test:webui` 355 / 0 · typecheck clean on core, shared, server-core,
  server, ui, session-tools-core · Headroom boundary gate green · all three i18n
  gates green (12 keys × 7 locales).

  **Not done, deliberately:** token *budget* displays and thresholds (SUV-0028)
  and memory stats (I2) are untouched. Two pre-existing conditions found and left
  alone, both outside this SUV: `apps/electron` typecheck has 108 errors (CI
  excludes it; none Headroom-related), its `lint` has 10 errors (all
  shadow-class/file-open rules in files this SUV does not touch), and
  `src/shared/__tests__/ipc-channels.test.ts` was already red at HEAD against a
  hand-maintained channel list whose generator (`scripts/ipc-inventory.ts`) is
  not in the repo — 15 channels had drifted before this SUV added 2.

  **Commit provenance, for anyone reading `git log` later.** SUV-0026 was being
  implemented concurrently in the same checkout and committed with a
  non-path-scoped `git commit`, which absorbed the transport half of this SUV
  into `bd68bed7` ("user-visible retrieval of compressed originals"): the
  `vorno:headroom:stats:*` channels, their routing classification,
  `ISessionManager.getHeadroomStatsReport` and its `SessionManager`
  implementation, the `getHeadroomStats` / `onHeadroomStatsChanged` electron API
  entries, and all 12 i18n keys across 7 locales. Nothing was lost and nothing
  was rewritten to recover it — the work is on the branch and correct; only its
  attribution is wrong. The remainder (adapters, report builder, view model, live
  controller, React surface, tests) is in this SUV's own commit.

