---
id: SUV-0012
title: Run one published task unattended and report findings to PLAN-039
status: planned
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
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

- [ ] One published task completes unattended with no human intervention mid-run.
- [ ] The DAG includes a verification node written to try to fail the run.
- [ ] Deliberately breaking an upstream node makes the verification node fail the run.
- [ ] A discussion doc exists listing every authoring gap, each with the concrete artifact that hit it.
- [ ] PLAN-039 references the discussion; PLAN-043's status log records the outcome.
- [ ] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
