---
id: PLAN-039
title: Workflow Definitions — reusable, parameterized, inspectable tasks
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-041-server-homed-instances-with-auth.md (sequel — definition ownership model must not preclude it)
  - PLAN-042-team-management.md (sequel)
blocked-by: []
---

# PLAN-039 — Workflow Definitions: reusable, parameterized, inspectable tasks

## Goal

A **Workflow Definition** is a saved, versioned, parameterized object a user can
run many times; a Task becomes one bound instance of a definition. A technical
information worker can save a workflow, run it from a typed form, watch it as a
DAG, and trust its steps to produce validated outputs — without ever seeing YAML.

## Evidence (why this, why now)

Audited 2026-08-22 against the primary workspace corpus and the renderer:

- **22 tasks, 18 runs, never a second run of any task.** The per-run storage
  layout (`runs/run-<id>/`) supports repeated runs and has never been exercised
  — there is nothing to re-run, because a task is authored once, executed once,
  and becomes a done board card.
- **75 authored nodes use exactly eight fields** (`id`, `title`, `prompt`,
  `kind`, `depends_on`, `model`, `llmConnection`, `permissionMode`) — precisely
  the `EditorSubtask` shape. The authored corpus is the editor's expressive
  ceiling.
- **Zero authored uses** of `params`, `outputs`, `inputs`, `when`, `loop`,
  `for_each`, `retry`, `aggregate`, `approval`, `token_budget` — the schema
  parses all of them (`packages/shared/src/tasks/schema.ts`), the editor
  (`TaskEditor.tsx` / `task-spec-form.ts`) exposes none of them.
- **Definition and instance are one object.** The task slug is the folder, the
  board card, and the orchestrator session binding; the editor's `fixedId`
  exists specifically to stop a title edit from forking a new folder and
  orphaning the bound session. "Reuse" is unrepresentable, not unimplemented.

The engine underneath needs no replacement: the Conductor already provides
event-sourced run logs, crash replay (`hydrateFromLog`/`resumeFromHydrated`),
bounded failure-aware retry, token budgets, and a verify/repair loop.

## Scope (phased)

### W1 — Definition/instance split *(the enabling move; everything else follows)*

- A definition store (workspace-level, file-backed, git-friendly) separate from
  `tasks/` instances: a definition is a `workflow.yaml` (same node schema)
  plus metadata (name, description, version, params).
- "Save as workflow" from an existing task; "New task from workflow" binding a
  definition version to a fresh instance (slug/folder/orchestrator session
  created at bind time, as `tasks:create` does today).
- Instances record which definition+version they were bound from; definitions
  list their run history across instances.
- **Design constraint:** the identity model must anticipate PLAN-041
  (definitions homed on a server, run by many users) without building any of it.

### W2 — Params + the run dialog

- Definition `params` (already in the schema, never surfaced) render as a
  typed form at run time — string/number/boolean/enum/date via the shared
  schema→form renderer. This is the "easy enough" bar: fields, not YAML.
- `${params.<name>}` interpolation already works in the runner; this phase is
  authoring + binding UI only.

### W3 — DAG view (read-only, Mermaid projection)

- Compile a definition (and a live run) to a natively-rendered Mermaid graph:
  nodes, `depends_on` edges, decision diamonds for `when`, back-edges for
  `loop`, run-state coloring from the existing node-state events.
- Explicitly *not* a node-graph editor; comprehension before authoring.

### W4 — Typed node outputs (the contract at the session boundary)

- A node's `outputs` declaration gains a schema; the child session is run with
  structured output enforced at the boundary (the SDK mechanism —
  `structured_output` + `error_max_structured_output_retries` — already exists
  in `claude-llm-query.ts`, today used only by `call_llm` and flattened to text).
- `NodeOutput` gains `data` beside `text`; `${nodes.<id>.output.<field>}`
  resolves from validated data (the ref parser already accepts `.field`).
- Validation failure becomes a **retryable node failure**: un-hardcode
  `retryMatches` (the `'invalid'` trigger is already in `RETRY_WHEN`, with
  detection explicitly deferred in the runner) so contract violations inherit
  the existing retry/backoff/replay machinery for free.
- **Inferred schemas:** after a run, offer "lock this shape" from the observed
  output. Workers confirm schemas; they do not compose JSON Schema.

### W5 — Control-flow authoring (last, and viewer-gated)

- Surface `when` / `for_each` / `loop` / `retry` in the editor **only for
  constructs W3 can already display**. Runner execution for deferred kinds is
  enabled per-construct as authoring lands, not wholesale.

## Non-goals

- No second engine, no workflow-service dependency (Temporal/Hatchet/etc.).
- No database. File-backed storage is retained; multi-writer coordination
  (leases, instance ownership) is PLAN-041.
- No node-graph *editing* canvas in this plan (W3 is a projection).
- No cross-workspace definition sharing/marketplace (DIR-02 territory).

## Approach notes

- The schema→form renderer built in W2 is reused verbatim in W4 (output
  schemas) — build it once as a shared component, not inside TaskEditor.
- `task-spec-form.ts` already round-trips generated specs losslessly; W1
  extends that round-trip to definition metadata rather than replacing it.
- Mermaid rendering, validation (`mermaid_validate`), and theming are already
  native to the shell; W3 is a compiler, not a renderer.

## Acceptance

- [ ] A task can be saved as a definition and a new task instantiated from it; the original task's session binding is undisturbed.
- [ ] Two instances of one definition coexist with independent runs, statuses, and board cards.
- [ ] A definition with params presents a typed form on run; the bound instance records the supplied values.
- [ ] A definition and a live run render as a DAG (Mermaid projection) including `when`/`loop` where authored.
- [ ] A node with an output schema fails-and-retries on invalid output via the `'invalid'` retry trigger; `${nodes.<id>.output.<field>}` resolves typed fields.
- [ ] "Lock this shape" proposes a schema from an observed run output.
- [ ] Round-trip tests: definition → instance → editor → definition is lossless (extends the `task-spec-form` invariant).
- [ ] Docs: a `vorno.ai/docs` guide authored for the information-worker audience.

## Status log

- `2026-08-22` — created in `planned/` as the first half of the DIR-05 milestone (top roadmap priority).
