---
id: PLAN-039
title: Workflow Definitions — reusable, parameterized, inspectable tasks
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-30
related:
  - PLAN-041-server-homed-instances-with-auth.md (sequel — definition ownership model must not preclude it)
  - PLAN-042-team-management.md (sequel)
  - PLAN-043-roadmap-console-interactive-work-surface.md (the detour that precedes W1 and becomes this plan's test harness)
  - ../discussions/2026-08-24-plan-043-authoring-gaps-for-plan-039.md (W1's evidence base — every gap PLAN-043 hit authoring, publishing and running a definition by hand)
related-suvs:
  - SUV-0045-definition-instance-split-data-model.md
  - SUV-0034-reconcile-published-task-definitions-into-board-cards.md
  - SUV-0035-reuse-the-orchestrator-session-across-task-runs.md
  - SUV-0036-surface-a-task-tile-whose-definition-is-missing.md
blocked-by:
  - PLAN-043
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

### W3 — DAG view (Mermaid projection with an interactivity bar)

- Compile a definition (and a live run) to a natively-rendered Mermaid graph:
  nodes, `depends_on` edges, decision diamonds for `when`, back-edges for
  `loop`, run-state coloring from the existing node-state events.
- **Interactivity bar — a static picture is not enough.** The projection must
  support, at minimum: **click a node → open the thing it represents** (the
  node's session, or its output artifact once W4 lands) and
  **collapse/expand groups** (subgraphs). The shell's renderer already
  provides the seam: `beautiful-mermaid` inlines the SVG into the React tree
  (no iframe, no message bridge needed) and stamps every node/edge/subgraph
  with semantic `data-id` / `data-from` / `data-to` attributes — one
  delegated click handler over `g.node` elements is node-level interaction
  with **no renderer change**. Pan/zoom already exists in the fullscreen
  overlay (`useRichBlockInteractions`); the work is composing per-node
  clicks with it (drag-vs-click discrimination, and suppressing the current
  whole-block tap-to-fullscreen behavior on this surface). Upstream
  mermaid.js `click` directives are *not* the mechanism — the vendored
  renderer doesn't parse them.
- **Project-level execution visualization.** During a run, the answer to
  "where does this ask sit?" must be zoomable across three levels: the
  **ask**, the **task** (this DAG), and the **project** — an overall body of
  work. Near-term this is "lanes of work" composed from existing primitives
  (projects, labels, kanban); the DAG view is the task-level pane of that
  picture, not a standalone artifact. See DIR-05 "Seeing the work" for the
  long-term concern (kanban cannot show information flows once workflows
  exist) — W3 does not solve that, but its click-through-to-session
  behavior is deliberately the first stepping stone toward DIR-04 dynamic
  workspaces and an eventual node-graph editor.
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

### W6 — Run outcome semantics *(the vocabulary and the terminal states control flow needs)*

Verified 2026-08-26 by reading `packages/server-core/src/tasks/TaskRunner.ts` (937 lines)
against `packages/shared/src/tasks/schema.ts`. The driving shape is a single
plan-level `task.yaml` for PLAN-040: ~60 nodes (15 SUVs × orient → implement →
verify → adversarial-verify), published only at plan level. These are the four
things that shape hits first, and this plan owns them because each is a
*definition-layer* concept before it is a runner change.

- **Firm up the vocabulary first.** `workflow`, `task`, `task set`, `subgraph`,
  and `node` are used interchangeably across the schema, the runner, and the
  roadmap, and the ambiguity is now load-bearing: the remaining W6 items all
  need a name for "a group of nodes smaller than the run and larger than a
  node." W1's definition/instance split is the moment to fix the terms, since
  it is already renaming the objects. No new construct ships under a term this
  plan has not defined.
- **A partial-success terminal state.** `maybeFinish()` computes `allGood` over
  *every* node (`state === 'done' || 'skipped'`); a single non-`done` node →
  `finish('failed')` → `run-failed`, and `finish()` settles the orchestrator
  tile to needs-review. A run where 14 of 15 SUV branches completed is
  indistinguishable from one where nothing worked. The definition needs a way
  to express "mostly succeeded, these branches are blocked" and the run needs a
  terminal status that carries it.
- **Repair must be reachable after a hard failure.** The verify→repair loop is
  entered *only* from the `allGood` path in `maybeFinish()`
  (`enterVerifying()` → orchestrator verdict → `handleVerdict()` →
  `repairForVerdict()`). Any hard-failed node calls `finish('failed')` first and
  skips verification entirely — so the repair loop can today only ever fix a run
  in which nothing actually failed. This is the single highest-leverage fix: the
  scoped-repair mechanism already exists (below) and is merely unreachable.
- **Retry budget scoped to a subgraph.** Per-node `retry` (`limit` + `when`) *is*
  honored today, in `failNode()`. `max_iterations` is run-global — clamped once
  in the constructor into `this.maxRepairs` and consumed by `handleVerdict()`
  for the whole run. There is no budget between those two scopes. A 60-node
  graph needs "this SUV's four nodes get two repair passes", not one number for
  all fifteen branches.
- **`cache` is declared but dead.** `CACHE_MODES` (`pure` | `off`) exists at
  `packages/shared/src/tasks/schema.ts:48` and the node field at `:166`; the
  string `cache` appears **zero** times in `TaskRunner.ts`. Re-running a task
  re-executes every node, so there is no way to restart one failed branch of a
  large graph without re-running all of it. This is exactly the "a field the
  system accepts but cannot honour is a defect" constraint below, already in the
  shipped schema.

**Already correct — preserve, do not "fix"**

- **Failure isolation works.** `failNode()` does not abort the run: it marks the
  node `failed` and calls `scheduleReady()`. `isReady()` requires every dep to be
  `done`, so dependents of a failed node stay `pending` while independent
  branches run to completion. This is the desired semantics and every W6 change
  must preserve it.
- **Scoped repair already exists as a mechanism.** The verdict grammar in
  `sendVerification()` accepts `VERDICT: FAIL — nodes=<id>,<id> — <reason>`, and
  `computeFrontier()` expands the named nodes to their transitive dependents.
  Nothing needs inventing here; it is only unreachable per the item above.
- **`node.kind` is never dispatched on.** `dispatch()` runs every node as a
  session regardless of kind — the file header states v1 executes only
  `kind: 'session'`, with route/loop/approval parsing but not executing. W5 owns
  closing that; W6 assumes it stays true and does not depend on it.

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

## Salvaged from prior plans (PLAN-045 Pass 1)

Ideas mined 2026-08-22 from plans that predate DIR-05. Each is carried here with
a back-pointer; the source plan is not the place to look them up again.

**Constraints this plan inherits**

- **A field the system accepts but cannot honour is a defect, not a shortcut.**
  PLAN-032 refused to add `ContextProfile.skills` as a no-op field precisely
  because "a silently ignored field is the exact defect PLAN-030 exists to
  eliminate." W5 is the same hazard at schema scale: never surface a
  control-flow construct the runner will not execute, and never leave one
  executable that W3 cannot display. ← `PLAN-032-session-sticky-skills.md`
- **A rule the API cannot express is a rule that silently never runs.** The
  `session-archive-sweeper` carried "never archive a flagged session" for its
  entire life and could not check it once, because the surface returned no such
  field; two flagged sessions were archived. A node `outputs` contract with no
  evaluation path is the same shape. ← `PLAN-037-session-query-predicate-surface.md`
- **Dispatched is not achieved.** Automation `ok` means the action was
  dispatched, never that it succeeded (LEARNING-052). W4's node success must be
  *structurally observed* — schema-validated output at the boundary — and never
  inferred from the child session's prose. ← `PLAN-030-session-lifecycle-automation.md`
- **Guards are proven by mutation, not assertion.** PLAN-030 Phase 0 shipped a
  `KNOWN_ACTION_TYPES` guard that was a tautology and passed unconditionally;
  PLAN-031 answered with documented mutation checks and a fail-closed default.
  The definition/instance drift guards inherit both rules.
  ← `PLAN-031-status-invariants-at-the-choke-point.md`
- **Do not fabricate progress you do not have.** There is no SDK task
  percent/total-steps signal (the only `percentage` fields are context-window
  usage), and PLAN-009 deliberately shipped "ran 2m 3s" rather than fake a
  relative "ago" it had no timestamp for. W3 run-state coloring derives from
  real node-state events only. ← `vorno-internal:plans/PLAN-008`, `PLAN-009`

**Reusable material**

- **The SDK already emits task progress that Vorno drops on the floor.**
  `SDKTaskProgressMessage` (`task_id`, `description`, `subagent_type`,
  `usage{total_tokens, tool_uses, duration_ms}`, `last_tool_name`, `summary`)
  and `SDKTaskStartedMessage.workflow_name` arrive with no
  `subtype === 'task_progress' | 'task_started'` case in `ClaudeEventAdapter`.
  Investigated against SDK `0.3.170`; **re-verify against the pinned version
  before relying on it.** This is W3's per-node progress substrate for free.
  ← `vorno-internal:plans/PLAN-008-orchestration-richer-progress.md`
- **Item-renderer registry as the contribution seam.** `Map<itemKind,
  RendererComponent>` with a default renderer, already shipped in
  `packages/ui/src/components/orchestration/`. A DAG node kind or a run-record
  row can register a renderer without a new surface.
  ← `PLAN-007-orchestration-activity-panel-done.md`
- **Derive, don't re-plumb.** PLAN-007 Phase 1 built a whole orchestration
  surface with zero new wire traffic, purely as derived state, and only *then*
  scoped an additive protocol phase. W3 should exhaust the same path before
  proposing any new event field. ← `PLAN-007`
- **Layout persistence for a graph view.** Time-axis on first paint, user drag
  sticky in a per-session sidecar — the one piece of the abandoned canvas work
  that survives its stack. ← `PLAN-001-canvas-session-spectator-v0.md`
- **A typed run form is a composed surface.** PLAN-026 specifies a versioned
  JSON composition over the existing trusted block catalog. W2/W4's
  schema→form renderer may be an instance of that spec rather than bespoke UI —
  worth deciding once, not twice. ← `PLAN-026-composed-surfaces-v1.md`

**Open question this raises**

- **Pinned model ids go stale.** A definition pins `model`/`llmConnection` per
  node, and vendor model drops/retirements are routine — the fork already built
  live enumeration because static catalogs fell behind. A saved definition needs
  a resolution-and-validation story at bind time, not a hard failure months
  later. ← `vorno-internal:plans/PLAN-010-live-model-enumeration.md`

## Acceptance

- [ ] A task can be saved as a definition and a new task instantiated from it; the original task's session binding is undisturbed.
- [ ] Two instances of one definition coexist with independent runs, statuses, and board cards.
- [ ] A definition with params presents a typed form on run; the bound instance records the supplied values.
- [ ] A definition and a live run render as a DAG (Mermaid projection) including `when`/`loop` where authored.
- [ ] Clicking a DAG node opens the node's session (or output artifact); subgraph groups collapse/expand; no renderer fork required.
- [ ] A node with an output schema fails-and-retries on invalid output via the `'invalid'` retry trigger; `${nodes.<id>.output.<field>}` resolves typed fields.
- [ ] "Lock this shape" proposes a schema from an observed run output.
- [ ] Round-trip tests: definition → instance → editor → definition is lossless (extends the `task-spec-form` invariant).
- [ ] The plan defines `workflow` / `task` / `task set` / `subgraph` / `node` once, and no construct ships under an undefined term.
- [ ] A run where some branches complete and others hard-fail reaches a partial-success terminal state, not `run-failed`.
- [ ] A run containing a hard-failed node still reaches verification, and a `nodes=` FAIL verdict repairs only the named nodes and their dependents.
- [ ] A repair/retry budget can be declared for a subgraph, independent of both per-node `retry` and run-global `max_iterations`.
- [ ] `cache: pure` is honored: re-running a task reuses prior node outputs and re-executes only the invalidated branch.
- [ ] Failure isolation is unchanged: dependents of a failed node stay `pending` while independent branches finish (regression test).
- [ ] Docs: a `vorno.ai/docs` guide authored for the information-worker audience.

## Status log

- `2026-08-22` — created in `planned/` as the first half of the DIR-05 milestone (top roadmap priority).
- `2026-08-22` — amended from product-owner review of PR #171: W3 gains an interactivity bar (clickable nodes, collapse/expand — grounded in the shell's `beautiful-mermaid` `data-*`/inline-SVG seam) and the ask→task→project visualization requirement; sequenced behind the PLAN-043 dogfooding detour.
- `2026-08-24` — **W1 now has an evidence base**: [`2026-08-24-plan-043-authoring-gaps-for-plan-039.md`](../../discussions/2026-08-24-plan-043-authoring-gaps-for-plan-039.md), delivered by PLAN-043 SUV-0012. It records every gap hit authoring, validating, publishing and running a real definition by hand — grouped as schema/validation, dispatch/environment, composer/authoring, publish/instance-split, and run/verification — each with the artifact that produced it, plus the five unattended runs (one clean, four sabotaged) behind them. Three findings bear directly on W1's shape: a DAG node cannot fail a run (grading is always a session reading a prose rubric, and `kind: verify`/`kind: judge` parse but do not execute); the repair loop feeds the verifier's rejection reason back into the rejected node's prompt, so a repair-enabled run cannot test whether a node is honest; and the definition/instance split has no third, **run-local** scope, which is where a per-run working directory needs to live. The doc ends with the seven questions this forces W1 to answer — including whether the authoring surface's expressive ceiling gets to be lower than the schema's, now that two independently built authoring tools have landed on the same eight fields.
- `2026-08-24` — first decomposition round, scoped to the enabling move only: SUV-0014 (definition/instance split in the store) and SUV-0015 (typed param form at bind time). W2–W5 remain undecomposed.
- `2026-08-24` — second decomposition round, at owner request: collapsed to a single SUV covering the definition/instance split only. SUV-0015 (typed param form at bind time) dropped and its file deleted; W2's params work is explicitly out of SUV-0014's scope and remains undecomposed alongside W3–W5.
- `2026-08-26` — **W6 added**: four runtime gaps verified by reading `TaskRunner.ts` — no partial-success terminal state (`maybeFinish()`/`allGood`), repair unreachable after a hard failure (`finish('failed')` precedes `enterVerifying()`), no subgraph-scoped retry budget between per-node `retry` and run-global `max_iterations`, and a `cache` field the runner never reads. Firming up the workflow/task/task-set/subgraph/node vocabulary is folded in as W6's first item, at owner request. Driven by the plan-level ~60-node `task.yaml` for PLAN-040. Recorded alongside three behaviors that already work correctly and must be preserved.
- `2026-08-30` — **branch hygiene, no scope change.** This plan's four SUVs were sitting on `plan/plan-039` against a base from 2026-08-25 (`f19d5d96`), so the console rendered them against a corpus that predated everything PLAN-040 landed since — the plan looked emptier and staler than it is. Rebased onto fresh `origin/main`; the four SUVs are unchanged. One id moved: **SUV-0033 → SUV-0045**, because PLAN-040 minted its own `SUV-0033` on 2026-08-27 and shipped it in v0.20.0 (main wins by possession; see SUV-0045's status log for the double-blind-spot cause). Sibling `plan/plan-040` was deleted the same day — fully merged, zero unique commits, and its lingering existence was what made the console report "PLAN-040 has work on 2 branches".
