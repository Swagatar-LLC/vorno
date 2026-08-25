# SUVs

A **Shippable Unit of Value** — the story-sized record between a plan and an
executable task. The folder an SUV lives in *is* its status.

Introduced by [ADR-0028](../decisions/0028-suv-as-the-shippable-unit-between-plan-and-task.md).

## Plan vs SUV

A **plan is a feature**. PLAN-043 spans a workstream view, a feedback loop, a
task composer, and a publisher — a body of work, not a change.

An **SUV is what one PR closes**. It has exactly one owning plan, an acceptance
list you can tick by reading a diff, and at most one task definition. If you
cannot state the goal in a sentence, it is two SUVs.

The point of the level is that a decomposing agent gets a scope boundary it
cannot invent its way around. An agent asked to advance a plan works at SUV
granularity — see the ADR's Context for the failure that motivated this.

## Folders

| Folder | Meaning |
|--------|---------|
| `planned/` | Drafted, not yet started. Anyone can pull one to start. |
| `in-progress/` | Actively being worked on. |
| `blocked/` | Waiting on external dependency or decision. Must fill `blocked-by`. |
| `done/` | Code landed, docs or release notes still pending. |
| `documented/` | Fully shipped — merged, docs updated, release-noted. |
| `archived/` | Abandoned without shipping. Kept for history. |
| `definitions/` | `SUV-NNNN.task.yaml` task definitions. **Status-independent** — flat, never moved. |

`documented/` reads oddly for a story-sized unit. It is kept anyway so that SUVs
and plans share one status set, one transition graph, and one advance skill.

## Lifecycle

```
planned ──▶ in-progress ──▶ done ──▶ documented
                │
                ├──▶ blocked ──▶ in-progress (when unblocked)
                │
                └──▶ archived (abandoned from any pre-done state)
```

Identical to the plan graph, verbatim. An SUV **must** start in `planned/`. To
advance:

```
[skill:roadmap-plan-advance] SUV-0001 in-progress
```

The skill performs `git mv` between folders and rewrites the frontmatter
`status` field so the two are always consistent.

## File naming

`SUV-NNNN-short-kebab-title.md` — **four**-digit zero-padded ID (plans use
three; the widths differ on purpose so an ID is unambiguous on sight), then a
kebab-case slug.

Find the next ID:

```bash
ls roadmap/suvs/*/SUV-*.md 2>/dev/null | grep -oE 'SUV-[0-9]+' | sort -u | tail -1
```

## Frontmatter

Every SUV starts with:

```yaml
---
id: SUV-0001
title: Put the roadmap console under version control
status: planned          # MUST match folder
plan: PLAN-043           # REQUIRED — exactly one owning plan
direction: DIR-05        # inherited from the plan
owner: jh
created: 2026-08-23
updated: 2026-08-23
related: []
blocked-by: []           # only used when status == blocked
---
```

See [`_template.md`](_template.md) for the full structure.

### The ownership edge

`plan:` is required and singular. The owning plan carries the reverse edge in
its `related-suvs:` list. Both sides are maintained — `[skill:roadmap-suv-create]`
writes them together.

SUVs are related to their plan, **not nested under it**. Plan files move between
status folders; nesting would drag every child along on every parent transition,
turning one `git mv` into a subtree rewrite.

## Body sections

- `## Goal` — the one-sentence outcome one PR delivers
- `## Scope` — what's in, and what a reader would wrongly assume in
- `## Acceptance` — checkable claims; ticking them all is what makes it `done`
- `## Status log` — append-only, one entry per transition

Keep it short. An SUV that reads like a plan is scoped like a plan.

## Task definitions

An SUV may carry at most one task definition:

```
roadmap/suvs/definitions/SUV-NNNN.task.yaml
```

Flat and status-independent — the definition never moves when the SUV advances.
It is versioned in git, reviewable in the PR that introduces it, and diffable
across revisions.

**Definitions are machine-neutral.** No cwd, no project ids, no model routes.
Those are supplied at publish time.

Publishing copies the definition to `{workspaceRoot}/tasks/<slug>/task.yaml`,
which `packages/shared/src/tasks/storage.ts` already scans. The repo file is the
authoritative **definition**; the workspace copy is a disposable **instance**.
Run state (`runs/<runId>/`) stays in the workspace and never returns to the
repo. Drift is resolved by re-publishing, never by copying back.

## When to write an SUV

- Whenever a plan is being decomposed for execution.
- Before starting work on a plan phase — the SUV is the scope contract.

Not every plan needs SUVs up front; write them when the plan reaches
`in-progress` and someone needs to know what "the next PR" means.
