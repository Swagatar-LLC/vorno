---
id: PLAN-045
title: Roadmap reduction pass — mine, then deprecate (scheduled 2026-08-29)
status: done
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
scheduled: 2026-08-29
related:
  - PLAN-043-roadmap-console-interactive-work-surface.md (the surface the mining pass runs on)
blocked-by: []
---

# PLAN-045 — Roadmap reduction pass

> **Scheduled: on or about 2026-08-29** (product-owner directive: schedule
> it, don't just note it). A dated Vorno task exists on the board for this;
> if the date slips, move the task, not just this file.

## Goal

Reduce product surface area so the remaining roadmap stands on **longer
poles** — fewer, deeper bets rather than many shallow ones. Two passes, in
order, because deprecation without mining first throws away buried value:

### Pass 1 — Mine

Sweep **all** existing plans (every status folder, including `blocked/`,
`archived/`, and the private corpus's paused plans) for still-valuable
ideas. An idea worth keeping is extracted into whichever DIR-05-era plan it
now belongs to (with a pointer back), not left where it is. Output: a short
mining report in `roadmap/discussions/` listing what was salvaged and where
it went.

### Pass 2 — Deprecate

With the value extracted, retire what no longer earns its place: plans that
predate the DIR-05 framing, surfaces nobody uses, bets overtaken by the
workflow/context milestone. Each deprecation is a `git mv` to `archived/`
with a one-line reason in its status log — reversible, and honest about why.

## Ground rules

- Mining strictly precedes deprecation; no plan is archived in the same
  sitting it is mined.
- Deprecation decisions that retire *shipped* surface (not just plans) get a
  product-owner sign-off line before any code is touched; this plan by
  itself only moves roadmap files.
- The pass is a bounded event, not a standing process — one week, one
  report, done.

## Acceptance

- [ ] Mining report in `roadmap/discussions/` covering every plan in every status folder (public + private paused).
- [ ] Salvaged ideas relocated into current plans with back-pointers.
- [ ] Deprecation candidates moved to `archived/` with reasons; anything touching shipped surface listed for product-owner sign-off instead of acted on.
- [ ] Roadmap README / directions index reflect the slimmer surface.

## Status log

- `2026-08-22` — created from product-owner review of PR #171 ("longer poles to stand on"); scheduled for 2026-08-29 with a dated board task (workspace task `roadmap-reduction-pass-2026-08-29-plan-045`, in todo — starting it is the product owner's call).
- `2026-08-22` — moved from `planned` to `in-progress`: Started in Vorno
- `2026-08-22` — moved from `in-progress` to `done`: Merging PR
