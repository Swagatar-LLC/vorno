---
id: SUV-0015
title: Headroom boundary module with no-op fallback
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related: []
blocked-by: []
---

# SUV-0015 — Headroom boundary module with no-op fallback

## Goal

Put the pinned Headroom SDK behind a single Vorno-owned TypeScript boundary
module whose no-op implementation keeps Vorno fully functional when Headroom is
absent or disabled.

## Scope

- A `HeadroomAdapter` interface (types in `packages/core`, implementation in
  `packages/shared`) covering the operations the plan will need — compress,
  retrieve original, stats — plus a factory that returns the real SDK-backed
  adapter or a no-op.
- The no-op adapter passes content through untouched and reports stats as
  absent (never fabricated — plan's "measured or absent" rule).
- A guard (lint rule or CI grep) so no file outside the boundary module imports
  the Headroom SDK directly — this is the long-term-support seam that contains
  future SDK upgrades.
- Deliberately out: config resolution (SUV-0016), any call sites in the session
  loop or Conductor (I1), and memory surfaces (I2).

## Acceptance

- [ ] A `HeadroomAdapter` interface exists in `packages/core` and the only production import of the Headroom SDK is inside the boundary module in `packages/shared`.
- [ ] The factory returns the no-op adapter when the SDK is unavailable or Headroom is disabled, and constructing it never throws — verified by a test that simulates the SDK package being absent.
- [ ] The no-op adapter returns input unchanged from compress/retrieve and reports stats as unknown/absent rather than zeros or estimates, with tests asserting both.
- [ ] A CI-enforced guard fails the build if any file outside the boundary imports the SDK directly.
- [ ] Tests exercise a realistic round-trip through the real adapter against the pinned SDK: compress a representative tool-output payload, retrieve the original, and get byte-identical content back.

## Status log

- `2026-08-25` — created in `planned/`
