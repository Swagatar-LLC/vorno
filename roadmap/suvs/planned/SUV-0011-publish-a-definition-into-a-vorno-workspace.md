---
id: SUV-0011
title: Publish a definition into a Vorno workspace
status: planned
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
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

- [ ] Publishing writes `{workspaceRoot}/tasks/<slug>/task.yaml` and Vorno lists the task after a board reload.
- [ ] Machine-local values appear only in the published copy; the repo definition still contains none.
- [ ] Republishing over a task with an existing `runs/` directory leaves `runs/` byte-identical.
- [ ] The focus deep link opens the published task using an action that exists on `main` today.
- [ ] The SUV shows "changed since publish" after the definition is edited.
- [ ] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
