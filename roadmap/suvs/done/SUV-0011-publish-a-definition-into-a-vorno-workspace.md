---
id: SUV-0011
title: Publish a definition into a Vorno workspace
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
  - SUV-0010-validate-task-definitions-against-the-real-schema.md
blocked-by: []
---

# SUV-0011 — Publish a definition into a Vorno workspace

## Goal

Publishing an SUV's definition writes `{workspaceRoot}/tasks/<slug>/task.yaml`
and Vorno picks it up on the next board load, with zero product change.

## Scope

- A publish action that copies the definition to the workspace layout
  `packages/shared/src/tasks/storage.ts` already scans, supplying the
  machine-local values — cwd, project id, model route — at publish time from
  console-side settings.
- Republish overwrites the spec file and **never touches `runs/`**.
- A deep link that only *focuses* the resulting task on the Vorno board, using
  the `vorno://` actions that exist today, unchanged.
- Publish state shown on the SUV: never published / published at `<time>` /
  definition changed since publish.

## Non-scope

- Nothing is ever copied back from the workspace into the repo. Drift is
  resolved by re-publishing.
- No new `vorno://` action, no DTO field, no `packages/` edit. That was PR #173.

## Acceptance

- [x] Publishing writes `{workspaceRoot}/tasks/<slug>/task.yaml` and Vorno lists the task after a board reload.
- [x] Machine-local values appear only in the published copy; the repo definition still contains none.
- [x] Republishing over a task with an existing `runs/` directory leaves `runs/` byte-identical.
- [ ] The focus deep link opens the published task using an action that exists on `main` today.
- [x] The SUV shows "changed since publish" after the definition is edited.
- [x] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting P5: publish a definition into a Vorno workspace, machine-local values supplied at publish time.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p3-p6-work-surface (5424531). Verified by the orchestrator: 177 tests green (26 new); live e2e composed, validated, and published a real two-node definition into my-workspace, round-tripped through the product own storage.ts (listTaskSlugs + loadTaskSpec, injected fields intact), republished over a runs/ dir proven byte-identical, then removed every artifact. Machine-local values are injected at publish time only; project id proj_8e5b523d is read live from the workspace projects config, never hardcoded. Validation gates publishing (invalid AND unvalidated refuse). ONE ACCEPTANCE ITEM UNSATISFIABLE, left unticked deliberately: no vorno:// action on main can focus a task — deep-link.ts:122 and route-parser.ts:65 have no task route, and nothing session-shaped exists for an unrun task to point at. Recorded as a PLAN-039 finding with a tripwire test that fails the day the product grows a task route. Bonus finding: claude-opus-5 is absent from the fork model registry (models.ts) while being the id existing published tasks habitually carry — surfaced as a publish warning, decision left to the owner.
