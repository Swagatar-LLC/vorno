---
id: PLAN-043
title: Roadmap console as an interactive work surface — the DIR-05 detour
status: in-progress
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-23
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

## Salvaged from prior plans (PLAN-045 Pass 1)

**D1 has been built once already — check before building it a third time.**

The review workbench shipped exactly this loop: select text in a rendered
markdown document → attach a comment → **route it as a question into a chosen
session** via `sessions:sendMessage`, embedding the artifact path, the quoted
anchor, and the thread id, with replies linked back on the thread. The code is
on `main` behind the `workbenchEnabled` flag. D1's "dispatch mechanism is a
design choice inside the phase" should start by evaluating that seam, not by
picking among deep-link / webhook / CLI from scratch.
← `PLAN-024-review-workbench-dynamic-workspace-v1.md`

Two disciplines come with it, and D1 needs both because roadmap documents change
under a selection:

- **Anchoring**: quote-anchored `AnnotationV1` targets plus an artifact
  `contentHash` (and `gitSha` for repo files).
- **Staleness**: badge the stale version; **never silently re-anchor.**
  ← `PLAN-024`, ADR-0014

**D2's corpus index may already exist.**

The artifact plane shipped in v0.13.0 behind `artifactsEnabled` and provides,
over `vorno:artifacts:*`: a zero-config scan of session `plans/` + `data/` plus
configured corpus roots (`roadmap/` is the named example), **frontmatter parsed
into the index** so roadmap ids/tags/titles are queryable for free, **typed
relations** (`derived-from`, `references`, `renders`, `discussed-in`), and a
join against `SessionHeader` context (project, labels, status). D2's workstream
view — "active direction, its driving ADRs, sequenced plans with blocked-by
edges" — is that relation model applied to the roadmap corpus. The console is
stdlib-Python and tailnet-local by design, so reuse may mean *reading the same
conventions* rather than calling the channels; either way, do not invent a third
relation vocabulary. ← `PLAN-025-artifact-plane-v1.md`

**Other carried material**

- **Agent-minable by construction.** The workbench stored threads as plain JSON
  under the workspace specifically so agents could find them with Read/Grep and
  no new tools were needed. The console's feedback and breakdown artifacts
  should hold the same property — it is what makes the dogfooding loop closed.
  ← `PLAN-024`
- **Cross-session roll-up as the shape for "what is the current workstream?"**
  The orchestration panel answered the runtime version of D2's question —
  active + recently-completed work across *all* sessions, grouped, with the
  focused one pinned — and completed items persisted rather than vanishing.
  ← `PLAN-007-orchestration-activity-panel-done.md`
- **The generator needs a journey test, not a unit test.** The console UI is
  declared throwaway and the `task.yaml` generator load-bearing; a generator
  regression is exactly the runtime, journey-level class of failure that passed
  every unit suite and lint gate in the PR #106 QA. The standard to borrow: *a
  deliberately reintroduced bug must make the check fail.*
  ← `PLAN-028-ci-user-journey-build-tests.md`

## Acceptance

- [x] From a rendered roadmap doc, select a region, attach feedback, and a Vorno session opens pre-loaded with doc id + excerpt + feedback.
- [x] Workstream view shows the active direction, driving ADR(s), and sequenced plans with relations.
- [ ] A plan can be broken down into a generated `task.yaml` that loads cleanly in TaskEditor and runs via the existing task surface.
- [ ] At least one generated breakdown runs unattended start-to-finish in the Vorno project, including an adversarial verification node.
- [x] Each gap or awkwardness the generator hits is recorded (status log or discussion doc) as input to PLAN-039 W1.

## Status log

- `2026-08-22` — created from product-owner review of PR #171; explicitly sequenced as the first executable step of DIR-05, before PLAN-039 W1.
- `2026-08-23` — moved from `planned` to `in-progress`: Starting implementation path
- `2026-08-23` — first usable work-surface slice built and live in the tailnet console. D2 now renders DIR-05 → ADR-0027 plus a plan lane ordered by current status, `related-plans`, and hard `blocked-by` edges. D1 stores quote-anchored feedback JSON with a document content hash and hands it to the existing `vorno://action/new-session` seam. D3 adds `vorno://action/new-task`, which opens the existing TaskEditor prefilled from the plan; the console never writes `task.yaml`.
- `2026-08-23` — D1 live journey verified: selecting “deliberate dogfooding” in the rendered PLAN-043 document wrote a quote-anchored feedback record, and the exact generated deep link opened session `260823-deft-nebula` in the Vorno project with the repo cwd and preloaded context. The in-app Chromium test window does not hand custom protocols to macOS; invoking the identical URL through the registered OS handler does.
- `2026-08-23` — requirements-probe findings for PLAN-039 W1: (1) sequence is not first-class in roadmap frontmatter — `blocked-by` expresses gates but not the intended PLAN-043 → PLAN-039 → PLAN-040 lane, so the console must combine current status and `related-plans` order; (2) TaskEditor knew the real model/connection catalog, but `tasks:generate` did not pass it to the authoring prompt, making valid explicit per-node routing impossible to request reliably — `TaskGenerateRequest.availableModelRoutes` now carries the optional catalog; (3) public deep-link parsing and renderer action handling were separate contracts — documented `new-chat` parsed and forwarded but had no renderer case, so it is now an explicit alias; (4) custom-protocol handoff cleanly avoids server credentials, but a running desktop build must contain the new action before the browser-side console can use it.
