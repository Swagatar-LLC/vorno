---
id: SUV-0036
title: Surface a task tile whose definition is missing
status: planned
plan: PLAN-039
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related:
  - SUV-0034-reconcile-published-task-definitions-into-board-cards.md
blocked-by: []
---

# SUV-0036 — Surface a task tile whose definition is missing

## Goal

Show a task tile whose `taskSlug` resolves to no `task.yaml` as broken, instead
of silently rendering it as a task with no subtasks.

## Scope

- `apps/electron/src/renderer/components/app-shell/kanban/KanbanBoardContainer.tsx`
  — the spec-node fetch swallows every failure (`catch { return [slug, []] }`,
  ~`:218`), so an unreadable *and* an absent definition both degrade to
  "children-only". Distinguish "no definition at this slug" from "definition
  read failed" and from "definition has zero nodes", and surface the first two
  on the tile.
- The tile must stay usable — a dangling slug is a state to report, not a crash
  or an empty card. The existing children-only fallback remains the render path.
- **Evidence this is real:** six sessions carried slugs like
  `plan-040-suv-0014-vet-and-pin-headroom-for-adopt` pointing at task folders
  that had been deleted. They rendered as ordinary cards with no rows and no
  working task interface, which read as "the task system is broken" rather than
  "this card is dangling." They were archived on 2026-08-26.
- **Out:** auto-repair — unbinding the session, re-creating the definition, or
  archiving the tile. Reporting only; what to do about it is the user's call.
- **Out:** the reverse direction (a definition with no session), which SUV-0034
  covers.

## Acceptance

- [ ] A session whose `taskSlug` has no `task.yaml` renders a visibly distinct
      tile naming the missing slug, not an ordinary card with zero rows.
- [ ] A definition that exists but fails to parse is distinguished from one that
      is absent, and both are distinguished from a valid definition with no nodes.
- [ ] Board load still completes with several dangling tiles present; one bad
      slug does not blank the board or block sibling tiles from fetching.
- [ ] The webui tests pass with a new case for the dangling-slug tile
      (`validate-pr.yml` runs webui tests strict).

## Status log

- `2026-08-26` — created in `planned/`
