---
id: SUV-0020
title: SUV id allocation consults unmerged candidate branches
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related:
  - SUV-0019-per-plan-topic-branch-as-the-breakdown-merge-target.md
blocked-by: []
---

# SUV-0020 — SUV id allocation consults unmerged candidate branches

## Goal

The next free `SUV-NNNN` is computed over the files on disk **plus** every
unmerged `breakdown/*` and `feedback/*` branch, so two concurrent breakdowns can
no longer claim the same id.

## Scope

- IN: a branch-aware id floor in the console — `git ls-tree` over the SUV paths
  of every live candidate branch, unioned with `corpus.next_id`'s scan of the
  two checkouts.
- IN: the breakdown dispatch prompt states the reserved floor in as many words
  ("ids at or below SUV-NNNN are taken, on disk or on an unmerged candidate
  branch — allocate above it"), so the agent in the worktree cannot re-derive a
  stale answer from its own glob.
- IN: the New-SUV dialog prefill uses the same floor.
- OUT: renumbering anything already colliding (the parked PLAN-039 candidate's
  SUV-0014 is the owner's merge-vs-discard call, not this SUV's).
- OUT: ids reserved outside git (project memory, private notes) — the manual
  override field already covers those and stays.

## Acceptance

- [ ] Reproduced first: a test that cuts a candidate branch claiming SUV-N and
  shows the old allocator hands out SUV-N again, then goes green with the fix.
- [ ] With a candidate branch holding `roadmap/suvs/planned/SUV-0021-x.md`
  unmerged, the New-SUV prefill and the breakdown prompt floor both report
  SUV-0022 as next free.
- [ ] A deleted/merged candidate branch stops reserving its ids without any
  manual cleanup.
- [ ] `python3 -m unittest test_server` stays green with the new cases.

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-25` — moved from `planned` to `in-progress`: Starting implementation.
- `2026-08-25` — moved from `in-progress` to `done`: Landed on console branch plan-043-retrospective-fixes (f66767f). Reproduced first: five new tests showed the corpus-only allocator handing a branch-claimed id out again. suv_ids_on_candidate_branches() scans every breakdown/* and feedback/* head; the floor feeds next_suv_id_for (breakdown prompt floor), the New-SUV prefill, and api_create; an override into a claimed id is refused naming the branches; reservation lifts when the branch merges or is deleted. 206 console tests green; service restarted, live next-free id SUV-0023 (correct: 0022 on disk, parked candidate branch claims only 0014 which is below the disk max).
