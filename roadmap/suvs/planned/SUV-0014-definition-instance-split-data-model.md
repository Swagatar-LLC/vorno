---
id: SUV-0014
title: Split workflow definitions from task instances in the store
status: planned
plan: PLAN-039
direction: DIR-05
owner: jh
created: 2026-08-24
updated: 2026-08-24
related: []
blocked-by: []
---

# SUV-0014 — Split workflow definitions from task instances in the store

## Goal

Introduce a workspace-level definition store, separate from `tasks/`, so a
workflow definition and a task instance are two distinct persisted objects and an
instance records the definition id + version it was bound from.

## Scope

- New file-backed store beside `tasks/` (a definition is `workflow.yaml` — the
  existing node schema — plus name, description, version, `params`), with
  read/write/list in `packages/shared/src/tasks/` alongside `storage.ts`.
- `TaskSpec` gains a binding record (definition id + version + bind timestamp)
  written at instance creation; definitions can enumerate their instances.
- Types in `packages/core` for the definition object and the binding record.
- Identity is opaque and location-independent so PLAN-041 can home definitions on
  a server later — a definition id is not a filesystem path.
- **Out:** the "Save as workflow" / "New task from workflow" UI commands, any
  editor change, and the run-local third scope raised by the PLAN-043 evidence
  discussion (`P1`/`P2`) — this SUV only lands the two-way split.

## Acceptance

- [ ] Definitions and instances are separate persisted types; creating an instance from a definition writes the definition id and version onto the instance, and `tasks/` never stores a definition.
- [ ] Two instances bound from the same definition coexist with independent slugs, folders, and `runs/` directories, and neither instance's edits mutate the definition file.
- [ ] Editing a definition after an instance is bound leaves that instance's recorded version unchanged (no silent re-binding).
- [ ] Round-trip test: definition → instance → `task-spec-form` → definition is lossless, extending the existing `task-spec-form.ts` invariant to the definition metadata.

## Status log

- `2026-08-24` — created in `planned/`
