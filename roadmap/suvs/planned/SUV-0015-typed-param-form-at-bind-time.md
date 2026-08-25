---
id: SUV-0015
title: Render a definition's params as a typed form at bind time
status: planned
plan: PLAN-039
direction: DIR-05
owner: jh
created: 2026-08-24
updated: 2026-08-24
related:
  - SUV-0014-definition-instance-split-data-model.md
blocked-by: []
---

# SUV-0015 — Render a definition's params as a typed form at bind time

## Goal

Surface a definition's `params` block as a typed form when a task is created from
that definition, and record the supplied values on the bound instance so
`${params.<name>}` resolves at run time.

## Scope

- A shared schema→form renderer component (in `packages/ui`, not inside
  `TaskEditor.tsx`) covering the param types the schema already parses:
  string / number / boolean / enum / date.
- Bind-time dialog: the form is presented when an instance is created from a
  definition; supplied values are persisted on the instance and read by the
  runner's existing `${params.<name>}` interpolation.
- Required params with no value block creation; defaults prefill.
- **Out:** authoring `params` in the editor (a definition's params are hand- or
  composer-authored for now), output schemas and "lock this shape" (W4), and any
  change to interpolation itself — that path already works.

## Acceptance

- [ ] A definition declaring string / number / boolean / enum / date params renders one typed control per param, driven by the schema rather than a hardcoded field list.
- [ ] The values supplied at bind time are persisted on the instance and readable from its stored record after a restart.
- [ ] A run of that instance resolves `${params.<name>}` to the supplied value in a node prompt, verified by a test over the runner.
- [ ] Submitting with a required param empty is refused with a per-field error and creates no instance.

## Status log

- `2026-08-24` — created in `planned/`
