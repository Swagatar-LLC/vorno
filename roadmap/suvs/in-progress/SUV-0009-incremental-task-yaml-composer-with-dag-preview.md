---
id: SUV-0009
title: Incremental task.yaml composer with DAG preview
status: in-progress
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
  - SUV-0010-validate-task-definitions-against-the-real-schema.md
blocked-by: []
---

# SUV-0009 — Incremental task.yaml composer with DAG preview

## Goal

An SUV's task definition can be built up across sessions in the console —
add a node, wire `depends_on`, edit inputs, save, come back later — and read
as a DAG.

## Scope

- Create and edit `roadmap/suvs/definitions/SUV-NNNN.task.yaml` from the SUV's
  page. The file is written on every save; a half-built definition is a normal,
  valid state to leave behind.
- Node operations: add, rename, delete, edit inputs, wire and unwire
  `depends_on`. Deleting a node that others depend on is refused, not cascaded.
- Mermaid DAG preview using the vendored `beautiful-mermaid`. Cycles render as
  an error state rather than a broken diagram.
- **Definitions stay machine-neutral**: no cwd, no project id, no model route.
  The composer must not offer fields for them.

## Non-scope

- No schema validation (SUV-0010) — this SUV may write a definition the real
  validator would reject.
- No publishing (SUV-0011).

## Acceptance

- [ ] A definition created in one session, closed, and reopened in another shows the same nodes and edges.
- [ ] Adding a node and wiring `depends_on` round-trips through the yaml file on disk.
- [ ] Deleting a depended-on node is refused with a message naming the dependents.
- [ ] The Mermaid preview matches the `depends_on` graph for a three-node fan-in.
- [ ] A cycle is reported as an error, not rendered.
- [ ] The composer exposes no field for cwd, project id, or model route.
- [ ] A journey-level test drives create → wire → save → reopen; deliberately reintroducing a persistence bug makes it fail.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: incremental task.yaml composer, developed in a console-repo worktree (plan-043-p4-composer) parallel to the P3 track.
