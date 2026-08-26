---
id: SUV-0035
title: Reuse the orchestrator session across task runs
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

# SUV-0035 — Reuse the orchestrator session across task runs

## Goal

Resolve a task's existing orchestrator session at run time so re-running a task
reuses its board card instead of minting a duplicate.

## Scope

- `packages/server-core/src/handlers/rpc/tasks.ts` — the `tasks:run` handler
  passes `req.orchestratorSessionId` straight through to `TaskRunner`. When the
  caller supplies none, resolve the session already bound to the slug before
  falling back to creating one.
- `TaskRunner` itself is not the right home: it deliberately never creates an
  orchestrator (`this.opts.orchestratorSessionId` is read-only throughout), and
  that separation should hold.
- Resolution is by `managed.taskSlug`, the same binding SUV-0034 reconciles on.
- **Evidence this is real:** five sessions in the primary workspace
  (`260824-prime-spruce`, `-prime-wolf`, `-lucid-glade`, `-coral-garnet`,
  `-tidy-tide`) are all bound to `suv-0012-reconcile-corpus-probe`, one per
  unattended re-run, each with its own `task-…-c-N` label — five cards for one
  task.
- **Out:** deciding what a re-run does to prior run history. Runs are already
  per-`runId` under `runs/<runId>/`; this SUV changes only which session the run
  is attached to.
- **Out:** any UI affordance for choosing between re-run and fresh-run.

## Acceptance

- [ ] Running a task twice with no explicit `orchestratorSessionId` produces
      exactly one board card, with both runs recorded under it.
- [ ] An explicit `orchestratorSessionId` from the caller still wins, unchanged.
- [ ] When two sessions are already bound to the same slug (existing corpora
      have this), resolution is deterministic and documented — it does not pick
      arbitrarily by map iteration order.
- [ ] A task whose bound session was archived or deleted still runs, minting a
      fresh orchestrator rather than throwing.
- [ ] `bun test packages/server-core` passes with a new case covering the
      second run of a task.

## Status log

- `2026-08-26` — created in `planned/`
