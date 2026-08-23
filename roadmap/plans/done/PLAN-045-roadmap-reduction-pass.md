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

- [x] Mining report in `roadmap/discussions/` covering every plan in every status folder (public + private paused).
- [x] Salvaged ideas relocated into current plans with back-pointers.
- [x] Deprecation candidates moved to `archived/` with reasons; anything touching shipped surface listed for product-owner sign-off instead of acted on.
- [x] Roadmap README / directions index reflect the slimmer surface.

## Status log

- `2026-08-22` — created from product-owner review of PR #171 ("longer poles to stand on"); scheduled for 2026-08-29 with a dated board task (workspace task `roadmap-reduction-pass-2026-08-29-plan-045`, in todo — starting it is the product owner's call).
- `2026-08-22` — moved from `planned` to `in-progress`: Started in Vorno
- `2026-08-22` — moved from `in-progress` to `done`: Merging PR
- `2026-08-22` — **Pass 1 (Mine) executed** on branch `roadmap/plan-045-reduction-pass`.
  46 plans inventoried (40 public across every status folder + 6 private paused);
  48 salvaged ideas relocated with back-pointers into PLAN-039/040/041/042/043/044.
  Report: [`roadmap/discussions/2026-08-22-plan-045-mining-report.md`](../../discussions/2026-08-22-plan-045-mining-report.md).
  **No file was moved, archived, or deleted** — Pass 2 (Deprecate) is a separate
  sitting per this plan's own ground rule. Twelve deprecation candidates are listed
  there, three of which touch shipped surface and are flagged for product-owner
  sign-off rather than acted on. The PLAN-023/024 scope disposition asked for
  alongside this pass is answered in the report's final section.
  Two carries for Pass 2: it must run **after PR #171 merges** (this branch was cut
  from `main` and does not see the status-audit folder moves), and
  `vorno-internal:plans/PLAN-010` needs reconciling against `main` before disposition.
- `2026-08-22` — **Pass 2 (Deprecate) executed** on the same branch, as a separate sitting.
  **Four public plans archived** with reasons in their own status logs: PLAN-023 (split, not
  shipped — Phase 0/ADR-0013 stay authoritative, Phases 1–3 now PLAN-041's), PLAN-026 and
  PLAN-027 (a three-deep blocked chain with no live head), PLAN-032 (its principle is now
  load-bearing in PLAN-039). **Private corpus:** the PLAN-007 duplicate deleted after
  verifying it a strict subset of the public archived file; PLAN-016 closed as `done`
  (completed verification record, mis-filed).
  **PLAN-010 reconciled and closed as `done`, not archived** — PR #36 merged to `main`
  (`4f7572d5`, 2026-06-25) two weeks *before* the corpus-wide pause banner was swept over it.
  Pass 1's disposition would have recorded a shipped feature as abandoned research.
  **Three plans held for product-owner sign-off, untouched:** PLAN-025 (artifact plane) and
  PLAN-035 (session shares), plus **PLAN-024, where Pass 2 reversed Pass 1** — its status log
  carries an explicit "do not close or move this plan unilaterally" instruction, and its
  workbench layers are live behind `workbenchEnabled`.
  **PLAN-028 retained and re-homed** under DIR-05 rather than archived; PLAN-043's `task.yaml`
  generator needs exactly its journey-test guard.
  Indexes updated: `ROADMAP.md`, DIR-03, DIR-04 (C2/C3 marked archived), DIR-05.
  Full record appended to [`2026-08-22-plan-045-mining-report.md`](../../discussions/2026-08-22-plan-045-mining-report.md).
  **Both passes complete.** This file was deliberately not moved to `done/`: PR #171 moves it
  `planned/` → `in-progress/`, and duplicating that move would add an avoidable merge conflict.
  Move it to `done/` once #171 lands — and resolve PLAN-023's rename/rename conflict in favour
  of `archived/`.
