---
id: SUV-0022
title: Add-SUV form records the reverse related-suvs edge on the owning plan
status: planned
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related: []
blocked-by: []
---

# SUV-0022 — Add-SUV form records the reverse related-suvs edge on the owning plan

## Goal

Creating an SUV through the console writes both sides of the ownership
relation — `plan:` on the SUV and the filename appended to the owning plan's
`related-suvs:` — so a form-created SUV validates instead of shipping an
invalid corpus.

## Scope

- IN: `server.py api_create` (kind `suv`): after writing the SUV file, append
  its filename to the owning plan's `related-suvs:` frontmatter list (creating
  the key after `related:` if absent), with the same atomic-write + mtime
  discipline as every other mutation.
- IN: the create response says what was updated, and a plan whose frontmatter
  cannot be safely rewritten fails the whole create rather than leaving one
  edge.
- OUT: repairing existing one-edged SUVs in the corpus (none exist today —
  the SUV-0013-era reproduction was cleaned up when Jeff's 0014–0018 merged
  with correct edges).

## Acceptance

- [ ] Reproduced first: a test creating an SUV via `/api/create` shows the
  validator rejecting the corpus before the fix and passing after.
- [ ] `POST /api/create {kind: suv, plan: PLAN-NNN}` leaves the plan's
  `related-suvs:` containing the new filename, block-list layout preserved.
- [ ] A create against a plan file the rewrite cannot parse fails atomically:
  no SUV file left on disk, error names the plan.
- [ ] `python3 -m unittest test_server test_validator` stays green.

## Status log

- `2026-08-25` — created in `planned/`
