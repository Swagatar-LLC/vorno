---
id: PLAN-043
title: Roadmap console as an interactive work surface — the DIR-05 detour
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md (this detour is its test harness and requirements probe)
  - PLAN-045-roadmap-reduction-pass.md (the mining pass runs on this surface)
blocked-by: []
---

# PLAN-043 — Roadmap console as an interactive work surface

> **This is the immediate detour — the first executable step of DIR-05,
> sequenced *before* PLAN-039 W1.** The roadmap console (the tailnet
> read/write PM surface over both corpora) grows from a viewer/editor into a
> real work surface that plans, decomposes, and dispatches agent work.

## Why a detour, and why first

Product-owner rationale, preserved as stated: this is **deliberate
dogfooding** — building the tool that *consumes* task breakdowns teaches us
what the workflow/task structure must be, and it becomes the **test harness
for PLAN-039** as it lands. Every gap the console hits when generating a
`task.yaml` from a plan is a requirement discovered *before* the
definition/instance split is designed, not after. The corpus evidence in
PLAN-039 (75 nodes, eight fields, zero control-flow uses) was gathered by
reading; this detour generates the *next* corpus deliberately.

## Scope

The console today: board/list/map views, omnisearch, in-place editing, plan
moves, roadmap-scoped commits (a local, tailnet-only, stdlib-Python app; the
markdown corpus stays the single source of truth). Four additions:

### D1 — Follow-up tool (feedback → session)

- Select/highlight a region of any roadmap document, attach feedback text,
  and **spawn a Vorno session pre-loaded with that context** (document id,
  the selected excerpt, the feedback) to plan the work.
- Dispatch mechanism is a design choice inside the phase: the app's
  deep-link scheme, the local trigger server's webhook surface (PLAN-014),
  or the CLI — pick the narrowest one that can carry a context payload;
  record the choice in the plan's status log.

### D2 — Workstream view

- A view answering "what is the current workstream?": the active direction,
  its driving ADR(s), and the sequenced plans with their inter-relations
  (blocked-by edges, sibling groupings) — the Map view sharpened from
  "everything referencing DIR-NN" into an ordered, annotated lane.

### D3 — Plan → task breakdown (the load-bearing piece)

- Break a plan into an executable decomposition and **generate a
  `task.yaml`** from it.
- Hand the breakdown to the existing task surface — TaskEditor /
  `tasks:create` — rather than a parallel one. Per-node `model` /
  `llmConnection` already exist in the schema; the breakdown assigns them.
- Queue the generated tasks in the Vorno project to run **unattended
  start-to-finish, including adversarial verification runs** (verify nodes
  are part of the generated breakdown, not an afterthought).

### D4 — Relations render (optional)

- An initial Mermaid render of plan/task relations inside the console
  (Mermaid is already vendored there); nice-to-have, cut first if time
  presses.

## Throwaway vs load-bearing (mark it honestly)

| Piece | Status | Why |
|---|---|---|
| Console-side UI (views, selection tool, workstream lane) | **Throwaway** | The console is a stopgap PM surface; DIR-04 dynamic workspaces is the destination for this UI |
| Anything that generates `task.yaml` (decomposition shape, node/verify structure, param plumbing) | **Load-bearing** | This *is* the requirements probe for PLAN-039's definition model; its output format migrates into the definition store |
| Session-dispatch-with-context mechanism (D1) | **Load-bearing** | Whatever carries "here is context, go plan" is the same seam PLAN-044 work requests will need |

## Non-goals

- No hardening of the console for anyone but the workspace owner; it stays
  local + tailnet-only, stdlib-only.
- No workflow-definition storage here — generated `task.yaml`s land in the
  existing `tasks/` surface; the definition store is PLAN-039 W1.
- No board/kanban replacement (that concern is DIR-05's visualization
  requirement, addressed in PLAN-039 W3 and beyond).

## Acceptance

- [ ] From a rendered roadmap doc, select a region, attach feedback, and a Vorno session opens pre-loaded with doc id + excerpt + feedback.
- [ ] Workstream view shows the active direction, driving ADR(s), and sequenced plans with relations.
- [ ] A plan can be broken down into a generated `task.yaml` that loads cleanly in TaskEditor and runs via the existing task surface.
- [ ] At least one generated breakdown runs unattended start-to-finish in the Vorno project, including an adversarial verification node.
- [ ] Each gap or awkwardness the generator hits is recorded (status log or discussion doc) as input to PLAN-039 W1.

## Status log

- `2026-08-22` — created from product-owner review of PR #171; explicitly sequenced as the first executable step of DIR-05, before PLAN-039 W1.
