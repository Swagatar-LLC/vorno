---
id: SUV-0004
title: Render SUVs on the console board and workstream view
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related:
  - SUV-0003-teach-corpus-py-the-suv-type.md
blocked-by: []
---

# SUV-0004 — Render SUVs on the console board and workstream view

## Goal

SUVs are visible and navigable in the console: as a status board, in list
views, and as a lane under their owning plan in the D2 workstream view.

## Scope

- List and board views for `suv`, driven by the same status columns as plans —
  one column set, not a copy.
- Filter by owning plan, and a link from a plan to its SUVs and back.
- Workstream view: extend the existing DIR-05 → ADR-0027 → plan lane with an
  SUV lane beneath the plan, ordered by current status.
- A plan in `in-progress/` with zero SUVs is called out — that is a plan nobody
  has decomposed, and it is the state that produced PR #173.

## Non-scope

- No editing of SUVs from the board beyond what plans already support.
- No composer surface (SUV-0009) and no publish action (SUV-0011).

## Acceptance

- [ ] `roadmap/suvs/*` records appear in a board with the same six status columns as plans.
- [ ] Opening a plan shows its SUVs; opening an SUV links back to its plan.
- [ ] The workstream view shows SUVs beneath their owning plan, status-ordered.
- [ ] An `in-progress` plan with no SUVs is visually flagged.
- [ ] The console still starts and renders with an empty `roadmap/suvs/` tree.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-23` — moved from `planned` to `in-progress`: Work executed 2026-08-23 in the PLAN-043 SUV bring-up.
- `2026-08-23` — moved from `in-progress` to `done`: Console UI landed (a0b2647). Verified in-browser: SUV facet and board columns, plan lane listing 12 SUVs, owning-plan panel on the SUV view, acceptance tracker, MOVE TO transitions, and the not-decomposed flag on in-progress PLAN-031. Break Down now creates SUVs; the reverted new-task deep link is gone.
