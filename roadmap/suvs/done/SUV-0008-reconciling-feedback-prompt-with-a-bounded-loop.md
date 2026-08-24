---
id: SUV-0008
title: Reconciling feedback prompt with a bounded loop
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
  - SUV-0005-dispatch-feedback-through-the-cli-instead-of-a-deep-link.md
  - SUV-0006-isolate-each-feedback-run-in-its-own-git-worktree.md
  - SUV-0007-corpus-validator-as-the-termination-predicate.md
blocked-by: []
---

# SUV-0008 — Reconciling feedback prompt with a bounded loop

## Goal

A feedback run reconciles the whole corpus against the human's intent — ADR,
plan, and every affected SUV — and stops in a defined state instead of editing
only the quoted line.

## Scope

- Prompt construction: the quoted anchor plus the human's verbatim words, the
  governing ADRs, the owning PLAN, and every SUV under it. The instruction is
  **reconcile**, not edit. Touching only the quoted line is a failure and the
  prompt says so.
- Termination: the run ends when the SUV-0007 validator passes *and* the run
  asserts the intent is satisfied. Bounded iterations; on exhaustion the record
  is surfaced as **unreconciled** with the last validator report attached.
- Conflict policy, encoded in the prompt and in the merge step:

  | Conflict | Resolution |
  |---|---|
  | Both sides appended to a status log | Union, ordered by date — never pick a side |
  | `updated:` frontmatter | Latest wins |
  | Same record moved to two statuses | Terminal-most legal state per the transition graph |
  | Contradictory prose edits | **Escalate to the human** |

- The commit message carries the human's words verbatim.

## Non-scope

- No new relation vocabulary. Reuse `derived-from` / `references` /
  `discussed-in` / `renders` from the artifact plane (PLAN-025).
- No re-anchoring of stale quotes — badge them, per ADR-0014.

## Acceptance

- [x] A feedback item whose intent spans an ADR and two SUVs produces edits to all three in one run.
- [x] A run that only edits the quoted line fails its own check rather than reporting success.
- [x] A run ends `reconciled` only when the validator exits 0.
- [x] Exceeding the iteration bound surfaces an `unreconciled` record with the validator report, and does not merge.
- [x] A synthetic status-log conflict merges as a date-ordered union with no entry lost.
- [x] A synthetic contradictory-prose conflict escalates rather than auto-resolving.
- [x] The commit message contains the feedback text verbatim.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: reconciling prompt + bounded loop over the SUV-0005/0006 dispatch machinery with the SUV-0007 validator as termination predicate.
- `2026-08-24` — first live run of the reconciliation loop. Feedback record `1787609926956-3e2a554f2d56`, dispatched through the SUV-0005 CLI path into its own SUV-0006 worktree on branch `feedback/1787609926956-3e2a554f2d56`, anchored on this record's "Bounded iterations; on exhaustion the record is surfaced as unreconciled" line. The run read the governing ADRs, the owning plan and all sibling SUVs, and reached past the quoted line into `SUV-0005` and `PLAN-043` — the reconciliation instruction behaved as specified end to end. Also added the missing reverse `related:` edge to SUV-0005, the dispatch path this SUV rides on.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p3-p6-work-surface (3f1631f). Verified by the orchestrator: 126 tests green (36 new, incl. stub-driven redispatch/exhaustion/union-merge/escalation coverage and the committed-conflict-markers validator check); live e2e reconciled in 1 of 3 iterations with a manifest matching the git diff byte for byte, edits spanning SUV-0008 + SUV-0005 + PLAN-043; merge exercised through the human gate into jh/plan-043-roadmap-work-surface (0ff9ab2d) with the commit carrying the feedback verbatim. One live defect found at merge teardown (untracked manifest dir blocked worktree removal) — fixed and regression-tested. Known limits recorded in the SUV: the moved-to-two-statuses conflict row escalates rather than auto-resolving (git reports it as rename/rename, and moving a file is a reconciliation job, not a merge job); a live unreconciled run has not been observed (covered by stub tests).
