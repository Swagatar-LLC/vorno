---
id: SUV-0045
title: Split workflow definitions from task instances in the store
status: planned
plan: PLAN-039
direction: DIR-05
owner: jh
created: 2026-08-24
updated: 2026-08-30
related: []
blocked-by: []
---

# SUV-0045 — Split workflow definitions from task instances in the store

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
- **Out:** anything W2 — a definition's `params` are persisted as opaque schema
  data here, with no typed bind-time form, no param authoring, and no change to
  `${params.<name>}` interpolation.

## Acceptance

- [ ] Definitions and instances are separate persisted types; creating an instance from a definition writes the definition id and version onto the instance, and `tasks/` never stores a definition.
- [ ] Two instances bound from the same definition coexist with independent slugs, folders, and `runs/` directories, and neither instance's edits mutate the definition file.
- [ ] Editing a definition after an instance is bound leaves that instance's recorded version unchanged (no silent re-binding).
- [ ] Round-trip test: definition → instance → `task-spec-form` → definition is lossless, extending the existing `task-spec-form.ts` invariant to the definition metadata.

## Status log

- `2026-08-24` — created in `planned/`
- `2026-08-24` — sole SUV for this round: SUV-0015 (typed param form at bind
  time) dropped at owner request, so W2 is explicitly named out of scope here
  and this SUV covers the definition/instance split only.
- `2026-08-26` — renumbered SUV-0014 → SUV-0033. The id collided with
  PLAN-040's `SUV-0014-vet-and-pin-headroom-for-adoption`, which was already on
  `origin/main`; this unit was still unmerged, so it moved. Cause: this
  breakdown record predates SUV-0019/0020, so it was allocated and merged
  without consulting unmerged candidate branches.
- `2026-08-30` — renumbered **SUV-0033 → SUV-0045**: the 2026-08-26 renumber
  above landed the unit on an id that PLAN-040 then minted independently one day
  later (`SUV-0033-publish-headroom-docs-page-to-vorno-site`, created 2026-08-27
  on `plan/plan-040`, since merged to `origin/main` and shipped in v0.20.0).
  Possession decided it: main's copy is immovable, this one was still unmerged,
  so this one moved. **The renumber reproduced the very collision it was fixing**
  — it picked `max+1` over the ids it could see, and PLAN-040's allocator could
  not see *this* branch either. Both directions of the same blind spot, one day
  apart. `SUV-0045` was allocated by the [ADR-0030](../../decisions/0030-suv-identity-is-global-per-plan-coherence-is-derived.md)
  all-refs sweep, which sees `plan/plan-047`'s unmerged SUV-0041..0044.
  This branch was also rebased onto fresh `origin/main` the same day; before
  that it still carried a 2026-08-25 base (`f19d5d96`), so the console showed
  its SUVs against a corpus that predated everything PLAN-040 landed since.
