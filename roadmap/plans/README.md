# Plans

Active work. The folder a plan lives in *is* its status.

## Folders

| Folder | Meaning |
|--------|---------|
| `planned/` | Drafted, not yet started. Anyone can pull one to start. |
| `in-progress/` | Actively being worked on. Should be small in number — ideally < 5. |
| `blocked/` | Waiting on external dependency or decision. Must include a `Blocked by` line. |
| `done/` | Code landed, but user-facing docs or release notes still pending. |
| `documented/` | Fully shipped — code merged, docs updated, release-noted. |

## Lifecycle

```
planned ──▶ in-progress ──▶ done ──▶ documented
                │
                └──▶ blocked ──▶ in-progress (when unblocked)
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
blocked-by: []           # only used when status == blocked
---
```

See [`_template.md`](_template.md) for the full structure.

## Body sections (suggested)

- `## Goal` — the outcome that closes this plan
- `## Scope` — what's in
- `## Non-goals` — what's deliberately out
- `## Approach` — short technical sketch
- `## Acceptance` — checklist that must be ticked to advance to `done`
- `## Status log` — append-only entries on each status transition

## When to write a plan

- Any work expected to take more than ~half a day.
- Any change that touches more than one package.
- Any new direction or paradigm move.
- Anything that will be merged via a PR worth reviewing.

Trivial bug fixes don't need a plan — just a PR.
