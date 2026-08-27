---
id: SUV-0038
title: Console allocator counts every ref, not just breakdown and feedback branches
status: planned
plan: PLAN-046
direction: DIR-05
owner: jh
created: 2026-08-27
updated: 2026-08-27
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

- [ ] The floor is computed over history across all refs, not over an
      enumerated list of branch-name prefixes.
- [ ] An id claimed only on a `plan/*` branch is refused for reuse.
- [ ] An id claimed only on a remote-tracking ref is refused for reuse.
- [ ] An id that existed and was renumbered away is still refused for reuse.
- [ ] A test reproduces the miss against the pre-change implementation and
      passes after; the full console suite stays green.

## Status log

- `2026-08-27` — created in `planned/`
</content>
