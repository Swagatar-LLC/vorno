---
id: SUV-0010
title: Validate task definitions against the real schema
status: planned
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related:
  - SUV-0009-incremental-task-yaml-composer-with-dag-preview.md
blocked-by: []
---

# SUV-0010 — Validate task definitions against the real schema

## Goal

The composer validates a definition with Vorno's own `validateTaskInput`, so
there is exactly one definition of "valid" and no second schema to drift from.

## Scope

- Shell out to `bun` to run `validateTaskInput` from
  `packages/shared/src/tasks/validate.ts` against the definition on disk;
  parse the result back into the console.
- Surface errors per node/field where the Zod issue path allows it, and as a
  document-level error otherwise.
- Degrade honestly: if `bun` or the repo path is unavailable, show
  "unvalidated" — never a green tick, and never a reimplemented check.
- **No Python re-statement of the schema.** Not even a partial one for fast
  feedback.

## Non-scope

- No change to `packages/shared/`. If the validator is not callable from a
  shell today, record it as a PLAN-039 finding and stop.

## Acceptance

- [ ] A valid definition validates green through the real `validateTaskInput`.
- [ ] A definition with an unknown node field is rejected with the field named.
- [ ] The reported error text comes from the Zod issue, not a console-side string.
- [ ] With `bun` unavailable, the UI shows "unvalidated" and no green state.
- [ ] `grep` over the console finds no schema field list duplicating `schema.ts`.
- [ ] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
