---
id: SUV-0034
title: Reconcile published task definitions into board cards
status: planned
plan: PLAN-039
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related:
  - SUV-0033-definition-instance-split-data-model.md
  - ../../decisions/0028-suv-as-the-shippable-unit-between-plan-and-task.md
blocked-by: []
---

# SUV-0034 — Reconcile published task definitions into board cards

## Goal

On workspace load, mint an orchestrator session for every `tasks/<slug>/task.yaml`
that has no session bound to its slug, so a definition published by any producer
appears on the board instead of silently existing on disk.

## Scope

- `packages/server-core/src/sessions/SessionManager.ts` — a reconciliation pass
  over `listTaskSlugs(ws.rootPath)` at workspace load, minting an orchestrator
  via the existing `createTaskFromSpec(..., { save: false })` for any slug with
  no bound session. Today `listTaskSlugs` is used only for slug-uniqueness
  (`:4502`) and the `tasks:list` RPC — nothing reconciles the directory.
- Binding is by `managed.taskSlug`. A slug that already has a session is a
  no-op; reconciliation is idempotent across restarts.
- An unparseable or invalid `task.yaml` is skipped with a warning, never a
  throw — one bad definition may not block workspace load.
- **Out:** the reverse direction (a bound session whose `task.yaml` has since
  disappeared). That dangling-`taskSlug` case is its own SUV — the tile
  currently swallows it in `KanbanBoardContainer.tsx:218`.
- **Out:** re-run orchestrator reuse. `tasks:run` accepts an
  `orchestratorSessionId` from its caller and mints nothing itself; callers
  passing none create a duplicate card per run. Separate SUV.

## Acceptance

- [ ] A `task.yaml` written directly into `{workspaceRoot}/tasks/<slug>/` by an
      external producer (no app involvement) appears as a board card after
      workspace load, with its spec nodes rendered as pending subtask rows.
- [ ] Reconciliation is idempotent: two consecutive loads of the same workspace
      produce exactly one orchestrator session per slug.
- [ ] A malformed `task.yaml` is skipped with a logged warning; sibling valid
      definitions still reconcile and workspace load still completes.
- [ ] The reconciled orchestrator carries `taskSlug`, the reserved Task label,
      and the spec's `sources`/`project`/`cwd` — i.e. it goes through the same
      `finishTaskOrchestrator` path as a fresh create.
- [ ] `bun test packages/server-core` passes with a new case covering an
      unbound published definition.

## Status log

- `2026-08-26` — created in `planned/`
