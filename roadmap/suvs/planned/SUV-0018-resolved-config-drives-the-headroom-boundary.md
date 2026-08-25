---
id: SUV-0018
title: Resolved config drives the Headroom boundary
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related: []
blocked-by: []
---

# SUV-0018 — Resolved config drives the Headroom boundary

## Goal

Feed the resolved per-workspace config into the boundary factory so the
settings toggle actually selects the real adapter or the no-op at session
construction time.

## Scope

- Wire `resolveHeadroomConfig()` (SUV-0016) into the boundary factory
  (SUV-0015) where sessions are constructed in `packages/shared`, passing the
  resolved option fields into the real adapter.
- Config is read at session start; a settings change applies to the next
  session, not mid-turn — the simple, predictable rule for this rung.
- Deliberately out: actually calling the adapter from the session loop or
  Conductor dispatch (I1 compression wiring is its own later SUV), token-stat
  surfaces (PLAN-002/003 migration), and memory (I2).

## Acceptance

- [ ] Session construction obtains its `HeadroomAdapter` from the boundary factory with the workspace's resolved config — no call site constructs an adapter directly.
- [ ] An end-to-end test covers the real path: workspace flag off → sessions get the no-op adapter; flag on → sessions get the real adapter constructed with the workspace's option values.
- [ ] Changing the workspace toggle affects the next constructed session and leaves in-flight sessions on the adapter they started with, asserted by a test spanning two sessions.
- [ ] With Headroom enabled but the SDK unavailable, session construction still succeeds on the no-op adapter and a warning is logged — Vorno remains fully functional (plan's graceful-degradation acceptance).

## Status log

- `2026-08-25` — created in `planned/`
