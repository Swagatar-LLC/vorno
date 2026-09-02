---
id: SUV-0048
title: Let a running session bind itself to a project, gated on declared intent
status: planned
plan: PLAN-048
direction: DIR-03
owner: jh
created: 2026-09-01
updated: 2026-09-01
related:
  - ADR-0021
blocked-by: []
---

# SUV-0048 — Intent-gated session self-binding to a project

## Goal

A running session that discovers which project it is working in can bind itself
to that project, and only when it has declared the intent to do so.

## Scope

- A session action that sets `projectId` on the current session.
- Gate it on **declared intent** per
  [ADR-0021](../../decisions/0021-session-actions-gated-by-declared-intent.md) —
  the gate is the declaration, not the transport. A session that has not declared
  the intent cannot bind itself no matter how the call arrives.
- Bind only; unbinding and rebinding to a different project are in scope only if
  they fall out for free.

**Deliberately out:** making this ambient or default. Per Jeff, 2026-09-01, this
is for sessions that are aware of the capability and deliberately invoke it —
"that shouldn't be something that happens most of the time." Cross-workspace
binding is also out.

## Why

`projectId` is accepted only at `spawn_session` and `create_task` time.
`get_session_info` reports a binding but nothing sets one. A session that learns
mid-run which project it belongs to has no way to say so, and therefore cannot see
the project's working directory or board context — the same spawn-time-only
limitation this plan is fixing for sources.

## Acceptance

- [ ] A session with the declared intent can bind itself to a project; the binding
      is visible in `get_session_info`
- [ ] A session without the declared intent is refused, regardless of transport
- [ ] Binding takes effect for the session's subsequent turns
- [ ] Refusals are explicit and legible, not silent no-ops
- [ ] Tests cover both the permitted and the refused path

## Status log

- `2026-09-01` — created in `planned/`
