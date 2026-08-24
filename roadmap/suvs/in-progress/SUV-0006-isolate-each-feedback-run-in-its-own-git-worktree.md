---
id: SUV-0006
title: Isolate each feedback run in its own git worktree
status: in-progress
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
  - SUV-0005-dispatch-feedback-through-the-cli-instead-of-a-deep-link.md
blocked-by: []
---

# SUV-0006 — Isolate each feedback run in its own git worktree

## Goal

Every feedback run gets a dedicated git worktree and branch, so two concurrent
runs editing the same ADR/PLAN/SUV cannot corrupt each other or the checkout.

## Scope

- One worktree per feedback record, on a branch named from the record id.
  `--workspace-dir` for the CLI run points at that worktree.
- Lifecycle: create on dispatch, keep on failure for inspection, remove on
  successful merge. An orphaned worktree is listed in the UI, never silently
  pruned.
- Merge is deliberate — the console proposes, the human accepts. Nothing
  auto-merges into `main`.
- **Never `git stash`, even transiently.** A repo-global stash has twice pulled
  another session's work into a worktree. Encode this as a hard prohibition in
  the dispatch code path and say why in a comment, not just in a doc.

## Non-scope

- Conflict *resolution* policy is SUV-0008. This SUV only guarantees isolation
  and a clean merge attempt.

## Acceptance

- [ ] Two feedback runs dispatched at once land in two distinct worktrees on two distinct branches.
- [ ] Neither run's edits appear in the primary checkout's working tree.
- [ ] A failed run leaves its worktree and branch in place, and the UI lists it.
- [ ] A merged run's worktree is removed and the branch deleted.
- [ ] No code path in the console or the dispatched prompt invokes `git stash`; a grep for it over both is empty.
- [ ] The primary checkout is clean before and after a run that touched nothing.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: worktree-per-feedback-run isolation in the console dispatch path. Orchestrated from session 260823-true-meadow.
