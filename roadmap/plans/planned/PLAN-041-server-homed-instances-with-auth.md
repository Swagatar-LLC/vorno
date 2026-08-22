---
id: PLAN-041
title: Server-homed instances with auth (STUB)
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-013-server-only-deployment.md (shipped foundation)
  - PLAN-023-hosted-workspace-server.md (in-progress foundation)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md
  - PLAN-040-context-discipline-adopt-headroom-extract-memory-library.md
blocked-by:
  - PLAN-039
  - PLAN-040
---

# PLAN-041 — Server-homed instances with auth *(stub)*

> **Stub.** This plan is deliberately unscoped. It exists so the DIR-05
> milestone (PLAN-039/PLAN-040) is designed with this destination in mind —
> definition ownership, instance identity, and storage seams must not preclude
> it. Do not start; expand into a real plan (goal/scope/approach/acceptance)
> when the DIR-05 milestone is done.

## Sketch

Workspaces and workflow definitions homed on headless server instances
(PLAN-013's deployment unit, PLAN-023's hosted-workspace direction), with:

- **Instance identity + authentication** — who may connect to an instance,
  beyond today's single WebUI password.
- **Run coordination** — which instance owns which workflow run; leasing so
  two workers never dispatch the same node; fencing for zombie instances.
  *This is the point where the storage question (SQLite-with-WAL vs. a real
  multi-writer store) actually becomes a durability-adjacent decision — not
  before.*
- **Multi-instance configuration** — a configuration layer for managing
  several instances without a heavyweight external service.

## Status log

- `2026-08-22` — created as a stub behind the DIR-05 milestone.
