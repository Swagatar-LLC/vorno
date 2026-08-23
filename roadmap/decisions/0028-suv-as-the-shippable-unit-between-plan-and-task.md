---
id: ADR-0028
title: SUV as the shippable unit between a plan and an executable task
status: proposed
date: 2026-08-23
supersedes: []
superseded-by: []
---

# ADR-0028 — SUV as the shippable unit between a plan and an executable task

## Context

The governance ladder runs DIR → ADR → PLAN → *executable work*, and the last
arrow has no artifact. A plan is a **feature**: PLAN-043 spans a workstream
view, a feedback tool, and a task generator. Nothing between "the feature" and
"a running DAG" declares a shippable boundary, so whoever decomposes a plan
invents one.

That gap has now cost us once. An agent asked to move PLAN-043 forward chose its
own scope, and produced eleven files of product change — including a field on an
upstream-owned DTO — for a plan whose stated premise was that the surface it was
building is throwaway (PR #173, reverted; recovery SHA `6714dcf3`). The scope
was never wrong against the plan, because the plan cannot express a scope that
small.

What is already true and worth reusing:

- **Folders encode status.** `roadmap/plans/<status>/` plus the transition graph
  in `corpus.py` is proven, skill-driven, and readable at a glance.
- **Tasks are already plain files.** `packages/shared/src/tasks/storage.ts`
  locks `{workspaceRoot}/tasks/<slug>/task.yaml`, and listing is a directory
  scan — no registry, no database, no watcher.
- **Run state lives beside the spec** in that same directory
  (`runs/<runId>/run-log.jsonl`), and is machine-local and disposable.

## Decision

**Introduce SUV — the Shippable Unit of Value — as a first-class corpus type
between PLAN and task.yaml. An SUV is tied to exactly one owning plan, carries
at most one task definition, and is the unit a PR closes.**

Concretely:

| Concern | Rule |
|---|---|
| Identity | `SUV-NNNN`, four digits, kebab slug — `SUV-0001-put-the-console-in-git.md` |
| Location | `roadmap/suvs/<status>/` — same status-folder mechanic as plans; **not** nested under the plan |
| Ownership | `plan: PLAN-043` in frontmatter; the plan carries `related-suvs:` for the reverse edge |
| Status | The plan status set and transition graph verbatim, so one graph and one advance skill serve both |
| Task definition | `roadmap/suvs/definitions/SUV-NNNN.task.yaml` — flat, status-independent, versioned in git |
| Task instance | Publishing copies the definition to `{workspaceRoot}/tasks/<slug>/task.yaml` |
| Run state | Stays in the workspace. **Never** returns to the repo. |

SUVs are tied to their plan **by relation, not by nesting**, because a plan file
itself moves between status folders. Nesting would drag every child SUV along
whenever the parent advanced, coupling two independent lifecycles and turning
one `git mv` into a subtree rewrite.

The definition/instance split falls out of the storage choice rather than being
designed: the file in `roadmap/` is the reusable **definition**, the copy under
`tasks/` is a disposable **instance**. This is the same split PLAN-039 is
chartered to build inside Vorno — reaching it here first, by hand, is the
requirements probe that plan needs.

## Consequences

### Positive

- A decomposing agent gets a scope boundary it cannot invent its way around.
- Task definitions become reviewable in the PR that introduces them, diffable
  across revisions, and portable across machines.
- Publishing needs **no Vorno change** — a written file in a scanned directory
  is the whole transport.
- The authored task.yaml corpus becomes direct evidence for PLAN-039, replacing
  the read-only corpus audit with one we generated deliberately.

### Negative

- A fourth document type to maintain: template, skills, scanner, board
  rendering, and the work-management instructions all grow a case.
- Two copies of a task exist once published, and they can drift. The definition
  is authoritative; drift is resolved by re-publishing, never by copying back.
- The public repo gains files that reference machine-local specifics (cwd,
  project ids, model routes). Definitions must keep those **out** — they are
  supplied at publish time, not authored into the file.

### Neutral

- SUV inherits the plan status set including `documented`, which reads oddly for
  a story-sized unit. Preferred over a second vocabulary; revisit only if it
  causes real confusion.
- Vorno has no filesystem watcher over `tasks/`, so a published task appears on
  the next board load rather than instantly.

## Alternatives considered

- **A directory per SUV** (`roadmap/suvs/<status>/SUV-NNNN/{SUV.md,task.yaml}`)
  — conceptually tidier, since the SUV would own its task outright. Rejected:
  it breaks the one-markdown-file-per-record assumption the corpus scanner, the
  ID glob, and the advance skill all rest on, for a filing convenience.
- **SUVs nested under the owning plan** — rejected above: plans move.
- **No SUV level; decompose plans straight into task.yaml** — the status quo,
  and the thing that produced PR #173.
- **Task definitions only in the workspace** — rejected: unversioned,
  unreviewable, machine-local, and lost on workspace reset. That is exactly the
  property that made last night's work impossible to review as an artifact.

## References

- DIR-05 (`../directions/05-workflows-and-headroom.md`) — the workflow direction
- PLAN-039 — workflow definitions; this ADR's definition/instance split is its probe
- PLAN-043 — the roadmap console work that applies this ADR first
- `packages/shared/src/tasks/storage.ts` — the locked task layout
- PR #173 (closed, reverted) — the scope failure that motivated this
