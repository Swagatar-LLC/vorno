---
id: SUV-0019
title: Per-plan topic branch as the breakdown merge target, visible in the UI
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related:
  - SUV-0013-trigger-a-vorno-session-from-the-roadmap-console-to-break-do.md
  - SUV-0020-suv-id-allocation-consults-unmerged-candidate-branches.md
blocked-by: []
---

# SUV-0019 — Per-plan topic branch as the breakdown merge target, visible in the UI

## Goal

A breakdown of PLAN-NNN merges into a per-plan topic branch cut from fresh main
at first dispatch, and the console always shows which branch a merge will land
on before the human accepts it.

## Scope

- IN: `server.py` — breakdown dispatch cuts (or reuses) a `plan/plan-nnn`
  branch from up-to-date `main` the first time any breakdown of that plan
  dispatches; run worktrees for that plan are cut from the plan branch tip;
  `/api/breakdown`-originated merges target the plan branch (via its own
  worktree, never by switching the primary checkout).
- IN: the merge proposal in the UI (runs drawer + breakdown dialog) names the
  target branch for **both** breakdown and feedback merges — no merge is
  accepted into an unnamed branch again.
- IN: the owner's working branch is out of the blast radius: a breakdown merge
  must not touch the primary checkout's branch or working tree.
- OUT: feedback-record merge *targets* stay the primary checkout's branch (a
  feedback record can anchor to a document with no owning plan, e.g. an ADR);
  only the visibility applies to them here. Redirecting feedback merges is a
  separate decision if the default proves wrong too.
- OUT: pushing. The console still never pushes; the plan branch is pushed from
  the CLI by a human.

## Acceptance

- [x] First dispatch of a breakdown of a plan creates branch `plan/plan-nnn`
  from up-to-date main (fetched if a remote exists; local main otherwise), and
  a second breakdown of the same plan reuses it.
- [x] Accepting a breakdown merge lands the candidate branch on the plan topic
  branch, `--no-ff`, and the primary checkout's branch and working tree are
  byte-identical before and after.
- [x] The merge proposal (API and UI) carries the target branch name for both
  breakdown and feedback records.
- [x] A dirty primary checkout no longer blocks a breakdown merge (the clash
  check applies to the tree the merge actually runs in).
- [x] `python3 -m unittest test_server` stays green, with new tests covering
  first-dispatch branch cut, reuse, merge target, and checkout isolation.

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-25` — moved from `planned` to `in-progress`: Starting implementation.
- `2026-08-25` — moved from `in-progress` to `done`: Landed on console branch plan-043-retrospective-fixes (9d87c78). First dispatch of a breakdown cuts plan/plan-nnn from the freshest reachable main (origin fetch best-effort), run worktrees stack on that branch, and acceptance merges into it inside a disposable merge worktree — the owner checkout is untouched and the dirty-checkout clash refusal no longer applies to plan-branch merges. Every merge surface names its target; API reports carry target for both kinds. Legacy records and feedback merges keep the checkout-branch target, now stated. 211 tests green (5 new). Live-verified after restart: all five existing records report their target correctly.
