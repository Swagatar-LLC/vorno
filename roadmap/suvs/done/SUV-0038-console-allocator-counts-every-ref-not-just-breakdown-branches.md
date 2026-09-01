---
id: SUV-0038
title: Console allocator counts every ref, not just breakdown and feedback branches
status: done
plan: PLAN-046
direction: DIR-05
owner: jh
created: 2026-08-27
updated: 2026-09-01
related:
  - SUV-0020-suv-id-allocation-consults-unmerged-candidate-branches.md (the partial fix this completes)
  - SUV-0019-per-plan-topic-branch-as-the-breakdown-merge-target.md (introduced the plan/* convention 0020 misses)
  - SUV-0037-allocate-suv-ids-across-every-git-ref-in-the-repo-instructions.md (same rule, repo side)
blocked-by: []
---

# SUV-0038 — Console allocator counts every ref, not just breakdown and feedback branches

## Goal

The console's SUV id floor accounts for every id that has ever existed on any
ref, so no branch naming convention can hide a claim from it.

## Scope

- `server.py` — `suv_ids_on_candidate_branches` (`:2872`) and `next_suv_id_for`.
  The `for-each-ref` call is scoped to `refs/heads/breakdown` and
  `refs/heads/feedback`; it misses `refs/heads/plan/*` (the convention SUV-0019
  introduced), all of `refs/remotes/*`, and ad-hoc branches (`roadmap/*`,
  `jh/*`).
- `test_server.py` — a regression test that fails against the current
  implementation.

Repo evidence: `SUV-0034`–`0036` live on `plan/plan-039` and are invisible to
the current allocator; the true all-refs maximum is `SUV-0036` while a fresh
`origin/main` worktree sees `SUV-0022`.

## Acceptance

- [x] The floor is computed over history across all refs, not over an
      enumerated list of branch-name prefixes.
- [x] An id claimed only on a `plan/*` branch is refused for reuse.
- [x] An id claimed only on a remote-tracking ref is refused for reuse.
- [x] An id that existed and was renumbered away is still refused for reuse.
- [x] A test reproduces the miss against the pre-change implementation and
      passes after; the full console suite stays green.

## Status log

- `2026-08-27` — created in `planned/`
- `2026-08-27` — moved from `planned` to `in-progress`: implemented as console
  PR #1 (`suv-0038-allocator-all-refs`). `suv_ids_on_candidate_branches` became
  `suv_ids_claimed_anywhere` — the old name described the reach that was the
  bug. One `git log --all --source` over `roadmap/suvs`; 237 refs in 82 ms,
  measured because it runs on every `/api/index`. Writing the tests found a
  second defect: git reports a renumber as a **rename**, so `--diff-filter=A`
  misses every id that entered by being renamed into — how SUV-0033 came to
  exist. The filter is gone, and the same correction was pushed back to
  SUV-0037's recipe. Tests 180 + 51 = 231 (226 before, 5 new), all five failing
  against the previous implementation.
- `2026-09-01` — moved from `in-progress` to `done`: acceptance fully met; landed as console PR #1 (`suv-0038-allocator-all-refs`). `suv_ids_claimed_anywhere` now reaches every ref.
