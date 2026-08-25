---
id: SUV-0006
title: Isolate each feedback run in its own git worktree
status: done
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

- [x] Two feedback runs dispatched at once land in two distinct worktrees on two distinct branches.
- [x] Neither run's edits appear in the primary checkout's working tree.
- [x] A failed run leaves its worktree and branch in place, and the UI lists it.
- [x] A merged run's worktree is removed and the branch deleted.
- [x] No code path in the console or the dispatched prompt invokes `git stash`; a grep for it over both is empty.
- [x] The primary checkout is clean before and after a run that touched nothing.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: worktree-per-feedback-run isolation in the console dispatch path. Orchestrated from session 260823-true-meadow.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p3-p6-work-surface (4145a96). Verified by the orchestrator: 90 tests green (18 new WorktreeIsolation/NoStash tests against real git); live e2e run created worktree + branch feedback/1787608305316-d129a2bc3475, wrote its probe file there and nowhere else, primary checkout byte-identical before/after; merge proposal correctly refused the out-of-scope path with a 409; discard endpoint tore down worktree and branch cleanly. Deviation from scope prose recorded: --workspace-dir must NOT point at the worktree (the product writes workspace state into workspace roots) — runs are steered by envelope paths + defaults.workingDirectory on a per-run workspace, and each run gets its own CRAFT_CONFIG_DIR because the headless server takes one exclusive .server.lock per config dir. Root-caused en route: the launchd PATH lacked /usr/sbin, so the vault key derived from a fallback and the product deleted the vault as corrupt — LEARNING-065; the SUV-0005 vault-expiry finding was a misdiagnosis of this.
