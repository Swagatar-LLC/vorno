---
id: SUV-0012
title: Run one published task unattended and report findings to PLAN-039
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md
  - SUV-0011-publish-a-definition-into-a-vorno-workspace.md
blocked-by: []
---

# SUV-0012 — Run one published task unattended and report findings to PLAN-039

## Goal

One authored definition runs start-to-finish unattended, including an
adversarial verification node, and every awkwardness hit while authoring by
hand lands as written input to PLAN-039 W1.

## Scope

- Pick a real definition — the reconciliation loop from P3 is the honest
  candidate, since it is a small DAG that already needs a verification node.
- Run it unattended in Vorno end to end. The verification node is adversarial:
  it tries to fail the run, and a passing run means it could not.
- Write the findings up as a discussion doc under `roadmap/discussions/`:
  every gap hit in the composer, the schema, publishing, and the run — what the
  definition model could not express, what had to be worked around, what the
  definition/instance split cost.
- Link the discussion from PLAN-039 and from PLAN-043's status log.

## Non-scope

- No design of PLAN-039's definition model here. This SUV supplies evidence,
  not the answer.
- No product change to make the run succeed. A blocking gap is a *finding* and
  the run is reported as blocked.

## Acceptance

- [x] One published task completes unattended with no human intervention mid-run.
- [x] The DAG includes a verification node written to try to fail the run.
- [x] Deliberately breaking an upstream node makes the verification node fail the run.
- [x] A discussion doc exists listing every authoring gap, each with the concrete artifact that hit it.
- [x] PLAN-039 references the discussion; PLAN-043's status log records the outcome.
- [x] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting P6: compose the reconciliation-loop DAG as this SUV task definition, publish it, run it unattended with an adversarial verify node, and write the PLAN-039 findings doc.
- `2026-08-24` — moved from `in-progress` to `done`: Complete. The reconciliation-probe DAG (SUV-0012.task.yaml) was composed entirely through the console API, bridge-validated, published into my-workspace, and run unattended five times against a disposable worktree cwd: run-1787622446237 completed 4/4 nodes with a pass verdict (the adversarial node independently re-derived the SUV census and validator report, catching the naive-grep trap, before conceding); sabotage of the direct upstream produced VERDICT: FAIL from the adversarial node itself and run-failed (run-1787623406869); repair-off sabotage failed on the rubric gate (run-1787622990291). Negative results worth as much as the passes: a repair-enabled run absorbs sabotage (the retry prompt leaks the verifier reason — run-1787622661840 fail→pass), and a verifier wired to one edge verifies that edge, not the chain. Drift restored by one republish (two-line diff). Findings doc: discussions/2026-08-24-plan-043-authoring-gaps-for-plan-039.md, 31 findings, linked from PLAN-039 and PLAN-043. Zero diff under packages/ or apps/ across the entire arc. Verified by the orchestrator: run logs on disk, validator exit 0, corpus clean.
