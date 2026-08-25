---
id: SUV-0009
title: Incremental task.yaml composer with DAG preview
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

- [x] A definition created in one session, closed, and reopened in another shows the same nodes and edges.
- [x] Adding a node and wiring `depends_on` round-trips through the yaml file on disk.
- [x] Deleting a depended-on node is refused with a message naming the dependents.
- [x] The Mermaid preview matches the `depends_on` graph for a three-node fan-in.
- [x] A cycle is reported as an error, not rendered.
- [x] The composer exposes no field for cwd, project id, or model route.
- [x] A journey-level test drives create → wire → save → reopen; deliberately reintroducing a persistence bug makes it fail.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Starting: incremental task.yaml composer, developed in a console-repo worktree (plan-043-p4-composer) parallel to the P3 track.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p4-composer (5153823). Verified by the orchestrator: 45 tests green in the worktree (17 new: taskdef.py YAML-subset round-trip incl. a cross-check that the product own yaml module reads what the console writes, refusal paths for out-of-subset/hand-annotated files, API contract, journey test); journey-test teeth proven by deliberately breaking persistence and watching it fail; browser-verified end to end on an ad-hoc worktree server — create definition, add three nodes, wire a fan-in via the wire action, DAG preview rendered a/b into c, cycle wiring refused with the path named and no write, no machine-local fields anywhere. Implementation agent stalled after finishing the work (2.5h, context spent) and was stopped; the orchestrator completed verification. En route: LEARNING-066 (a git checkout -- restore destroyed the agent uncommitted server.py; recovered by replaying the transcript edit log).
