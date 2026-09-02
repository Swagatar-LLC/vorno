---
id: SUV-0037
title: Allocate SUV ids across every git ref in the repo's own instructions
status: done
plan: PLAN-046
direction: DIR-05
owner: jh
created: 2026-08-27
updated: 2026-09-01
related:
  - SUV-0020-suv-id-allocation-consults-unmerged-candidate-branches.md (fixed the console only)
  - SUV-0038-console-allocator-counts-every-ref-not-just-breakdown-branches.md (same rule, console side)
blocked-by: []
---

# SUV-0037 — Allocate SUV ids across every git ref in the repo's own instructions

## Goal

The two next-id recipes an agent working in this repo actually reads stop
handing out ids that already exist on another branch.

## Scope

- `.agents/skills/roadmap-suv-create/SKILL.md` — step 3 (L46–48), the tools list
  (L101), the example (L113), and the batch-decomposition note (L93).
- `roadmap/suvs/README.md` — the "Find the next ID" recipe (L64–66).
- `.agents/skills/roadmap-plan-advance/SKILL.md` — only if the allocation change
  affects it; it does not write ids today, so expect no change beyond a
  cross-reference.

Both recipes are currently a working-tree glob. Neither has been edited since
`b3d39e9d`, including by SUV-0020 — whose fix landed entirely in the external
console repo.

## Acceptance

- [x] Both recipes read the floor from `git log --all` over `roadmap/suvs`,
      not from a working-tree glob, and carry no `--diff-filter=A` (git reports
      a renumber as a rename, so an add-filter misses it).
- [x] Both state that an id which has ever existed is permanently claimed and
      never reused, and that gaps are expected.
- [x] The documented command returns `SUV-0036` where the old glob recipe
      returned `SUV-0022` in a clean `origin/main` worktree — the reproduction
      recorded in ADR-0030 and in this SUV's status log.
- [x] `grep -rn "ls roadmap/suvs" .agents/ roadmap/ --exclude='SUV-0037-*'`
      returns nothing — no max+1-over-glob allocation instruction survives.
- [x] The batch note keeps its "allocate in one sweep" rule and states the sweep
      starts from the all-refs floor.
- [x] The skill's tools list and worked example no longer tell the agent to
      `Glob` for the id.
- [x] Both recipes reserve the id on the remote (`refs/suv-ids/SUV-NNNN`, via
      `git push --atomic`) **before** any file is written, and the floor is read
      as the union of history and that namespace.
- [x] A second claim of an already-reserved id is rejected — demonstrated
      against `origin`, not asserted.
- [x] The batch note reserves all N in a single `--atomic` push, so a partially
      contended block claims nothing.

## Status log

- `2026-08-27` — created in `planned/`
- `2026-08-27` — moved from `planned` to `in-progress`: both recipes rewritten.
  Reproduction captured before the change, in a worktree cut from `origin/main`
  (`aa9311dd`): the old glob recipe returned `SUV-0022`, the all-refs command
  returned `SUV-0036` — a 14-id gap that would have allocated `SUV-0023`, an id
  already shipped on `plan/plan-040` (PR #180). `roadmap-plan-advance` needed no
  change: it never writes ids and never touches `related-suvs:`.
- `2026-08-28` — review (PR #181) correctly held that the wider read fixes
  *visibility*, not *atomicity*: two workflows that both read before either
  writes still collide. Added remote reservation refs (`refs/suv-ids/SUV-NNNN`)
  as a compare-and-swap ahead of the write, and ADR-0030 gains point 4. Verified
  against `origin`: first claim `* [new reference]`, second claim of the same id
  `! [rejected] … (non-fast-forward)` exit 1; a two-id `--atomic` sweep
  containing one taken id created neither ref. Test refs deleted. The race is
  closed for workflows that reserve; a workflow that hand-authors an id without
  reserving is still caught only by the validator.
- `2026-09-01` — moved from `in-progress` to `done`: acceptance fully met and merged in PR #181. Independently exercised 2026-09-01 while allocating SUV-0046..0048: the all-refs floor returned SUV-0045 (a working-tree glob would have under-read it), and all three CAS reservations on `refs/suv-ids/*` succeeded on first push. The recipe works as documented.
