---
id: SUV-0008
title: Reconciling feedback prompt with a bounded loop
status: in-progress
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
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

- [ ] A feedback item whose intent spans an ADR and two SUVs produces edits to all three in one run.
- [ ] A run that only edits the quoted line fails its own check rather than reporting success.
- [ ] A run ends `reconciled` only when the validator exits 0.
- [ ] Exceeding the iteration bound surfaces an `unreconciled` record with the validator report, and does not merge.
- [ ] A synthetic status-log conflict merges as a date-ordered union with no entry lost.
- [ ] A synthetic contradictory-prose conflict escalates rather than auto-resolving.
- [ ] The commit message contains the feedback text verbatim.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: reconciling prompt + bounded loop over the SUV-0005/0006 dispatch machinery with the SUV-0007 validator as termination predicate.
