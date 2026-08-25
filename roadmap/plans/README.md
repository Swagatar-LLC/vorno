# Plans

Features. The folder a plan lives in *is* its status.

A plan is not a unit of execution — it is a body of work. It decomposes into
**SUVs** (`../suvs/`), each of which is what one PR closes. When you are asked
to advance a plan, work at SUV granularity rather than choosing your own scope.
See [ADR-0028](../decisions/0028-suv-as-the-shippable-unit-between-plan-and-task.md).

## Folders

| Folder | Meaning |
|--------|---------|
| `planned/` | Drafted, not yet started. Anyone can pull one to start. |
| `in-progress/` | Actively being worked on. Should be small in number — ideally < 5. |
| `blocked/` | Waiting on external dependency or decision. Must include a `Blocked by` line. |
| `done/` | Code landed, but user-facing docs or release notes still pending. |
| `documented/` | Fully shipped — code merged, docs updated, release-noted. |
| `archived/` | Abandoned without shipping. Frontmatter `status: archived` with a status-log entry explaining why. Kept for history. |

## Lifecycle

```
planned ──▶ in-progress ──▶ done ──▶ documented
                │
                ├──▶ blocked ──▶ in-progress (when unblocked)
                │
                └──▶ archived (abandoned from any pre-done state)
```

A plan **must** start in `planned/`. To advance, run:

```
[skill:roadmap-plan-advance] PLAN-001 in-progress
```

The skill performs `git mv` between folders and rewrites the frontmatter `status` field so they're always consistent.

The terminal `done → documented` step has its own skill that also refreshes user-facing docs and runs a code review of the merged diff:

```
[skill:roadmap-plan-document] PLAN-001
```

## File naming

`PLAN-NNN-short-kebab-title.md` — three-digit zero-padded ID, then kebab-case slug.

> **Numbering gaps are expected.** Some IDs (e.g. PLAN-004, 008, 009, 010, 016) have no
> file in this public tree — they are the paused orchestration-era plans that live in the
> private `vorno-internal` corpus per ADR-0006 / ADR-0011. A missing ID is not a broken
> link.

Find the next ID:

```bash
ls roadmap/plans/*/PLAN-*.md 2>/dev/null | grep -oE 'PLAN-[0-9]+' | sort -u | tail -1
```

## Frontmatter

Every plan starts with:

```yaml
---
id: PLAN-001
title: Canvas Session — spectator v0.1
status: planned          # MUST match folder
direction: DIR-01        # link to roadmap/directions/
owner: jh                # GitHub handle or initials
created: 2026-04-28
updated: 2026-04-28
related: []
related-suvs: []         # SUV ids this plan decomposes into (reverse of the SUV's `plan:`)
blocked-by: []           # only used when status == blocked
---
```

See [`_template.md`](_template.md) for the full structure.

`related-suvs:` is maintained by `[skill:roadmap-suv-create]`, which writes both
halves of the edge. A plan with no SUVs yet carries `related-suvs: []`; a plan
in `in-progress/` with an empty list is a plan nobody has decomposed.

## Body sections (suggested)

- `## Goal` — the outcome that closes this plan
- `## Scope` — what's in
- `## Non-goals` — what's deliberately out
- `## Approach` — short technical sketch
- `## Acceptance` — checklist that must be ticked to advance to `done`
- `## Status log` — append-only entries on each status transition

## Decomposing a plan

Before executing, cut the plan into SUVs:

```
[skill:roadmap-suv-create] --plan PLAN-043 "Put the roadmap console under version control"
```

Each SUV is one PR's worth of change with its own acceptance list. The plan's
Acceptance stays as the feature-level checklist; the SUVs are how it gets ticked.

## When to write a plan

- Any work expected to take more than ~half a day.
- Any change that touches more than one package.
- Any new direction or paradigm move.
- Anything that will be merged via a PR worth reviewing.

Trivial bug fixes don't need a plan — just a PR.
