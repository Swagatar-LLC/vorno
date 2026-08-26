---
id: SUV-0027
title: In-app Headroom savings and stats report view
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
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

- [ ] A Headroom report view exists showing per-session and per-workspace stats (tokens before/after, savings, compressed-item count, retrieval count), and every figure traces to `adapter.stats()` — no computation of savings outside the adapter.
- [ ] Stats the adapter reports as absent render as unknown/absent; a test feeds a stats payload with missing fields and asserts no zeros or estimates appear.
- [ ] With Headroom disabled or the no-op adapter active, the view states that no stats are available rather than showing an empty chart of zeros.
- [ ] The view updates to reflect a newly completed session's stats without an app restart.

## Status log

- `2026-08-26` — created in `planned/`
