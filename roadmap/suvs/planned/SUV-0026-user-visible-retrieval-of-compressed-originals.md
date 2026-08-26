---
id: SUV-0026
title: User-visible retrieval of compressed originals
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (the retrieval handles this UI surfaces)
---

# SUV-0026 — User-visible retrieval of compressed originals

## Goal

Surface compression in the session UI so a user can see that an item was
compressed and view the byte-identical original on demand — reversibility as a
user-visible affordance, not just an internal cache.

## Scope

- Session view in `apps/electron`: compressed tool outputs carry a visible
  indicator (with the compressed/original size) and a "view original" action
  that fetches through `adapter.retrieve()`.
- Graceful failure: if retrieval fails, the UI says so — it never silently
  shows compressed content as if it were the original.
- Deliberately out: the aggregate stats/report view (SUV-0027) and any
  settings surfaces.

## Acceptance

- [ ] Compressed items in the session view show an indicator with compressed and original sizes; uncompressed items show nothing new.
- [ ] The "view original" action displays content byte-identical to the pre-compression original, verified by a test against a known payload.
- [ ] A failed retrieval shows an explicit error state rather than passing off compressed content as the original.
- [ ] With Headroom disabled, the session view renders identically to today — no dormant indicators.

## Status log

- `2026-08-26` — created in `planned/`
