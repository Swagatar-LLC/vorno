---
id: PLAN-043
title: Roadmap console as the SUV and task-authoring surface — the DIR-05 detour
status: in-progress
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-24
related:
  - ADR-0028-suv-as-the-shippable-unit-between-plan-and-task.md (the governance shape this plan implements)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md (this detour is its test harness and requirements probe)
  - PLAN-045-roadmap-reduction-pass.md (the mining pass runs on this surface)
related-suvs:
  - SUV-0001-put-the-roadmap-console-under-version-control.md (P1)
  - SUV-0002-suv-corpus-scaffolding-and-work-management-instructions.md (P2)
  - SUV-0003-teach-corpus-py-the-suv-type.md (P2)
  - SUV-0004-render-suvs-on-the-console-board-and-workstream-view.md (P2)
  - SUV-0005-dispatch-feedback-through-the-cli-instead-of-a-deep-link.md (P3)
  - SUV-0006-isolate-each-feedback-run-in-its-own-git-worktree.md (P3)
  - SUV-0007-corpus-validator-as-the-termination-predicate.md (P3)
  - SUV-0008-reconciling-feedback-prompt-with-a-bounded-loop.md (P3)
  - SUV-0009-incremental-task-yaml-composer-with-dag-preview.md (P4)
  - SUV-0010-validate-task-definitions-against-the-real-schema.md (P4)
  - SUV-0011-publish-a-definition-into-a-vorno-workspace.md (P5)
  - SUV-0012-run-one-published-task-unattended-and-report-findings-to-plan-039.md (P6)
  - SUV-0013-trigger-a-vorno-session-from-the-roadmap-console-to-break-do.md (owner-drafted 2026-08-24; acceptance TBD)
blocked-by: []
---

# PLAN-043 — Roadmap console as the SUV and task-authoring surface

> **The immediate detour — the first executable step of DIR-05, sequenced
> *before* PLAN-039 W1.** The roadmap console grows from a viewer/editor into
> the surface where plans are cut into SUVs, SUVs are composed into `task.yaml`
> definitions, and those definitions are published to Vorno.

## Why a detour, and why first

Product-owner rationale, preserved as stated: this is deliberate dogfooding —
building the tool that *consumes* task breakdowns teaches us what the
workflow/task structure must be, and it becomes the **test harness for
PLAN-039** as it lands. Every gap hit while authoring a `task.yaml` by hand is a
requirement discovered *before* the definition/instance split is designed, not
after.

## What the first attempt got wrong

PR #173 (closed; reverted, recovery SHA `6714dcf3`) implemented "Break Down" as
a **prompt launcher**: assemble prose, put it in a `vorno://` URL, hand off to
TaskEditor's Generate mode, which authors the whole DAG in one in-app LLM pass.
Because the artifact then only ever existed inside Vorno, the console had to
grow a new Vorno entry point to reach it — a `new-task` deep-link action, plus
`availableModelRoutes` on the upstream-owned `TaskGenerateRequest` DTO to
compensate for the generator not knowing the model catalog. Eleven files of
product change, none of it in the console, to serve a surface this plan calls
throwaway.

Two corrections follow, and they define this rewrite:

1. **The task definition is authored in the console and stored in the roadmap
   repo** (ADR-0028). It is a real, incremental, reviewable artifact, not a
   prompt.
2. **Publishing is a file write** to `{workspaceRoot}/tasks/<slug>/`, which
   `storage.ts` already scans. No Vorno change is required, and none should be
   made under this plan.

## Scope

Six phases, in order. Each phase is one or more SUVs; no phase starts before
its predecessor is green.

### P1 — Put the console under version control

`~/.craft-agent/serve/apps/vorno-roadmap/` has no `.git`. It is load-bearing PM
infrastructure that can write to both roadmap repos, and it has no history, no
branches, and no backup — determining when the "Break Down" button was added
required filesystem forensics. Give it a repository, a remote, and the same
never-push-to-main discipline as everything else. Decide public vs private on
the same axis the roadmap split uses.

### P2 — SUV as a first-class corpus type

- `SUV-NNNN` ids, `roadmap/suvs/<status>/`, plan status set and transition graph
  reused verbatim, `plan:` / `related-suvs:` relation edges (ADR-0028).
- `corpus.py`: type derivation, `ID_PREFIX` / `ID_WIDTH`, template.
- Console: SUVs on the board and list views, filtered by owning plan.
- **Bake it into the repo's work-management instructions** — `CLAUDE.md`,
  `AGENTS.md`, `roadmap/README.md`, `roadmap/plans/README.md`, and a
  `roadmap-suv-create` skill alongside the existing plan skills. An agent
  reading this repo cold must learn the ladder without being told.

### P3 — Reconciling feedback loop (CLI-driven, worktree-isolated)

Today's feedback tool captures intent and hands it to a human-attended session.
It must become a mechanism that *reconciles the corpus*.

- **Dispatch via the CLI, not a deep link.** `vorno-cli run <message>
  --workspace-dir <path>` spawns a server, runs headless, streams, and exits —
  a self-contained agent invocation the console can start and wait on. The
  deep-link path requires an attended desktop app; this does not.
- **The prompt instructs reconciliation, not editing.** The agent reads the
  governing ADRs, the owning PLAN, and any affected SUVs, then makes *every*
  change the feedback implies — across all of them — and continues until the
  corpus is internally consistent. Touching only the quoted line is a failure.
- **Every run gets its own git worktree.** Concurrent feedback runs will collide
  on the same ADR/PLAN/SUV. One worktree per feedback record, branch per record,
  merged deliberately. **Never `git stash` in this repo, even transiently** — a
  repo-global stash has already pulled another session's work into a worktree
  twice.
- **Conflicts are expected; resolve them by the corpus's own principles:**

  | Conflict | Resolution |
  |---|---|
  | Both sides appended to a status log | Union, ordered by date — never pick a side |
  | `updated:` frontmatter | Latest wins |
  | Same plan moved to two statuses | The transition graph decides; the terminal-most legal state wins (precedent: PLAN-023 rename/rename → `archived/`) |
  | Contradictory prose edits | **Escalate to the human.** Two intents in genuine conflict is not a merge problem. |

- **Intent carries through.** The human's words are stored verbatim, travel
  verbatim into the prompt and the commit message, and are never paraphrased
  into a summary. Conflict resolution preserves intent; it does not average it.
- **Termination is defined, not hoped for.** A run is reconciled when the corpus
  validates — frontmatter agrees with folder, transitions are legal, internal
  links resolve — and the feedback's intent is satisfied. Bound the loop and
  surface an unreconciled run rather than letting it spin.

Note for P6: this loop is itself a small DAG with a verification node. It is the
first honest customer of the composer, and what it needs is direct evidence for
PLAN-039.

### P4 — task.yaml composer

- Create and edit `roadmap/suvs/definitions/SUV-NNNN.task.yaml` incrementally —
  add a node, wire `depends_on`, edit inputs, save, come back later.
- **Validate against the real schema.** `packages/shared/src/tasks/schema.ts` is
  Zod and `validate.ts` exports `validateTaskInput`; the console is stdlib
  Python. Shell out to `bun` so there is exactly one definition of valid, rather
  than reimplementing the schema and letting the two drift.
- Mermaid DAG preview (`beautiful-mermaid` is already vendored in the console).
- Definitions stay machine-neutral: no cwd, no project id, no model routes
  baked in.

### P5 — Publish to Vorno

- Write the definition to `{workspaceRoot}/tasks/<slug>/task.yaml`, supplying
  the machine-local values at publish time.
- Deep-link only to *focus* the board — `vorno://` already supports this today,
  unchanged.
- Republish overwrites the spec and never touches `runs/`. Drift is resolved by
  re-publishing; nothing is ever copied back into the repo.

### P6 — Feed PLAN-039

Every awkwardness hit in P3/P4 is recorded as a status-log entry or discussion
doc. This is the deliverable that makes the detour worth taking — the input to
PLAN-039 W1's definition model.

## Non-goals

- **No Vorno product change under this plan.** If a phase appears to need one,
  that is a finding for PLAN-039, not a license to edit `packages/`.
- No hardening of the console for anyone but the workspace owner; local +
  tailnet-only, stdlib-only.
- No workflow-definition *store* — a flat directory of yaml files is the whole
  mechanism here. The real store is PLAN-039 W1.
- No board/kanban replacement (DIR-05 visualization; PLAN-039 W3 and beyond).

## Already built, keep

D2's workstream view is live in the console: DIR-05 → ADR-0027 plus a plan lane
ordered by current status, `related-plans`, and hard `blocked-by` edges. It
survived the revert because it is console-side. P2 extends it with SUVs.

D1's quote-anchored feedback tool is live, and its anchoring was rebuilt on
2026-08-23 after the first version proved unusable — see the status log.

## Salvaged from prior plans (PLAN-045 Pass 1)

**The feedback loop has been built once already — check before building it a
third time.**

The review workbench shipped exactly this loop: select text in a rendered
markdown document → attach a comment → **route it as a question into a chosen
session** via `sessions:sendMessage`, embedding the artifact path, the quoted
anchor, and the thread id, with replies linked back on the thread. The code is
on `main` behind the `workbenchEnabled` flag.
← `PLAN-024-review-workbench-dynamic-workspace-v1.md`

Two disciplines come with it, and both were re-learned the hard way:

- **Anchoring**: quote-anchored targets plus a content hash.
- **Staleness**: badge the stale version; **never silently re-anchor.**
  ← `PLAN-024`, ADR-0014

**The corpus index may already exist.**

The artifact plane shipped in v0.13.0 behind `artifactsEnabled` and provides,
over `vorno:artifacts:*`: a zero-config scan of session `plans/` + `data/` plus
configured corpus roots (`roadmap/` is the named example), **frontmatter parsed
into the index**, **typed relations** (`derived-from`, `references`, `renders`,
`discussed-in`), and a join against `SessionHeader` context. The console is
stdlib-Python and tailnet-local by design, so reuse may mean *reading the same
conventions* rather than calling the channels; either way, do not invent a third
relation vocabulary. ← `PLAN-025-artifact-plane-v1.md`

**Other carried material**

- **Agent-minable by construction.** The workbench stored threads as plain JSON
  under the workspace specifically so agents could find them with Read/Grep and
  no new tools were needed. SUVs, definitions, and feedback records all hold
  this property — it is what makes the dogfooding loop closed. ← `PLAN-024`
- **Cross-session roll-up as the shape for "what is the current workstream?"**
  ← `PLAN-007-orchestration-activity-panel-done.md`
- **The composer needs a journey test, not a unit test.** The console UI is
  throwaway and the definitions are load-bearing; a composer regression is
  exactly the runtime, journey-level failure that passed every unit suite in the
  PR #106 QA. The standard to borrow: *a deliberately reintroduced bug must make
  the check fail.* ← `PLAN-028-ci-user-journey-build-tests.md`

## Acceptance

- [ ] The console is a git repository with a remote and a stated branch discipline.
- [ ] `SUV-NNNN` exists as a corpus type: template, status folders, transition graph, board/list rendering, and a create skill.
- [ ] The repo's work-management instructions teach DIR → ADR → PLAN → SUV → task without external explanation.
- [ ] Feedback from a rendered doc starts a headless CLI run in its own worktree that reconciles the ADR/PLAN/SUV set and stops in a defined state.
- [ ] A `task.yaml` definition can be built incrementally across sessions, validated by the real `validateTaskInput`, and previewed as a DAG.
- [ ] Publishing writes a task Vorno picks up, with **zero diff under `packages/` or `apps/`**.
- [ ] One published task runs unattended start-to-finish, including an adversarial verification node.
- [ ] Every gap hit while authoring by hand is recorded as input to PLAN-039 W1.

## Status log

- `2026-08-22` — created from product-owner review of PR #171; explicitly sequenced as the first executable step of DIR-05, before PLAN-039 W1.
- `2026-08-23` — moved from `planned` to `in-progress`: Starting implementation path
- `2026-08-23` — first implementation attempt reverted (PR #173 closed, recovery SHA `6714dcf3`). Scope drifted into Vorno product change — a `new-task` deep-link action and an `availableModelRoutes` field on the upstream `TaskGenerateRequest` DTO — because "Break Down" was built as a prompt launcher rather than an authoring tool, leaving the task artifact reachable only inside Vorno. Root cause is a governance gap, not agent error: a plan is a feature, and nothing smaller declared a shippable boundary.
- `2026-08-23` — console feedback anchoring rebuilt after the handoff proved unusable on its first real trial. Two defects: quotes were captured from *rendered* text but matched against *raw markdown*, so any quote crossing a hard wrap or sitting inside `**bold**` could never resolve; and staleness was a whole-document hash, so appending to a status log — the most common write in this corpus — reported every intact anchor as broken. Fixed by matching against a rendered-text projection and re-resolving the quote plus 64 chars of stored context, yielding `ok` / `moved` / `ambiguous` / `missing`. Console-side only; survived the revert.
- `2026-08-23` — rewritten around ADR-0028. Five sequenced phases; the load-bearing correction is that a task definition is authored and versioned in the roadmap repo, and publishing is a plain file write into the layout `storage.ts` already scans — so this plan requires no Vorno change at all.
- `2026-08-24` — the feedback tool's anchoring failed a second time, one day after the rebuild: the HTML-side projection turned every tag into a space, so any selection containing a linked corpus id / code span / bold followed by punctuation could never resolve — and SUV-0005's hard-reject on unresolvable anchors turned that into a submission blocker. Found live on this plan's own first paragraph during SUV-0005 verification. Fixed console-side (`6c92fd2`: inline tags contribute nothing, block tags are boundaries) → LEARNING-064. Dogfooding lesson for PLAN-039's anchoring surfaces: capture side and resolve side must be the same function of the same input.
- `2026-08-23` — decomposed into twelve SUVs (`SUV-0001`–`SUV-0012`) covering all six phases, and the SUV corpus itself was scaffolded: `roadmap/suvs/` with the plan status folders verbatim plus `definitions/`, a template, a folder README, the `roadmap-suv-create` skill, and the ladder written into `CLAUDE.md` / `AGENTS.md` / `roadmap/README.md` / `roadmap/plans/README.md`. `roadmap-plan-advance` now serves both corpora off one transition graph. That is SUV-0002's own scope, landed alongside the record describing it.
- `2026-08-24` — P3's reconciling loop took its first live run, on feedback record `1787609926956-3e2a554f2d56` against SUV-0008 itself. All three P3 mechanisms composed as designed: SUV-0005's CLI dispatch started the run, SUV-0006 gave it a private worktree and branch, and the prompt's reconciliation instruction carried the edit past the quoted line into two sibling records (SUV-0005 and this plan) rather than stopping at the anchor. Evidence for P6: the loop's own shape — dispatch, reconcile, validate, stop — is the first DAG the P4 composer has to be able to express, and it was exercised here by hand before the composer exists.
- `2026-08-24` — **P6 closed: a definition this plan authored ran unattended, and a deliberate break failed it.** SUV-0012 composed `roadmap/suvs/definitions/SUV-0012.task.yaml` entirely through the SUV-0009 composer API — the P3 reconciliation loop as a four-node DAG (`survey` + `validate` → `reconcile-report` → `adversarial-verify`), machine-neutral, green through the SUV-0010 bridge — published it with SUV-0011, and ran it five times start to finish with no intervention against a disposable detached worktree. **Run 1** (`run-1787622446237`) completed clean: 4/4 nodes `done`, `VERDICT: PASS`, worktree untouched. **Run 3** (`run-1787622990291`) sabotaged `survey` in the published instance with a fabricated 15-SUV list; the gate returned `VERDICT: FAIL — nodes=survey` and the run ended `run-failed`. **Run 5** (`run-1787623406869`) sabotaged the adversarial node's own upstream; `adversarial-verify` itself returned `VERDICT: FAIL` after listing ten fabrications, and the run failed on it. Restored by re-publishing from the repo definition — ADR-0028's drift rule exercised for real, leaving a two-line diff against the first publish. Zero diff under `packages/` and `apps/`. Two results are worth carrying forward past this plan: **run 2** (`run-1787622661840`) showed the runner's repair loop *absorbing* the sabotage, because it hands the verifier's rejection reason to the rejected node as its next prompt — a repair-enabled run cannot test whether a node is honest; and the adversarial node's scope turned out to be its input edge, not the run, so a sabotage its upstream reported honestly left it with nothing to fault. Everything hit along the way is written up as [`2026-08-24-plan-043-authoring-gaps-for-plan-039.md`](../../discussions/2026-08-24-plan-043-authoring-gaps-for-plan-039.md), referenced from PLAN-039 — the last of this plan's eight acceptance items.
