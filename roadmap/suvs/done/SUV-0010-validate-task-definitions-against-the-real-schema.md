---
id: SUV-0010
title: Validate task definitions against the real schema
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
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

- [x] A valid definition validates green through the real `validateTaskInput`.
- [x] A definition with an unknown node field is rejected with the field named.
- [x] The reported error text comes from the Zod issue, not a console-side string.
- [x] With `bun` unavailable, the UI shows "unvalidated" and no green state.
- [x] `grep` over the console finds no schema field list duplicating `schema.ts`.
- [x] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: bun bridge to the real validateTaskInput, on the p4 composer branch.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p3-p6-work-surface via merge f5805aa (commit 2fd5f99). Verified by the orchestrator: 97 tests green in the p4 worktree, 151 green after the deliberate merge into the P3 track (two real merge defects found and fixed: colliding run_validator definitions renamed, and a union-truncated write_file restored — both parents structurally verified). Bridge validates through the real validateTaskInput plus runtime Zod-shape introspection for unknown keys (naming node and field, honouring the type:->kind: alias); degradation shows unvalidated with the reason, never a green tick; error text passes through from Zod verbatim; a non-vacuous grep test proves no second schema exists console-side. Live service healthy on the merged code.
