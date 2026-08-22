---
id: PLAN-042
title: Team management (STUB)
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-041-server-homed-instances-with-auth.md (prerequisite sibling)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md
blocked-by:
  - PLAN-041
---

# PLAN-042 — Team management *(stub)*

> **Stub.** Deliberately unscoped; exists so upstream design decisions
> anticipate it. Expand when PLAN-041 is real.

## Sketch

Users, roles, and sharing within a server-homed instance:

- **Accounts + roles** on an instance (owner / member at minimum; finer roles
  are a design question, not a given).
- **Shared workflow definitions** — authored once, runnable by teammates, with
  the run dialog (PLAN-039 W2) as the entire operating surface for a
  non-author.
- **Attribution + authority** — runs, approvals, and session actions carry who
  did them; interacts with the declared-intent authority model (ADR-0021).

Like PLAN-041, this lands **incrementally via ADRs + guiding principles**,
not as one big build: user awareness on instances, access control on
workflow definition files, and workflow versioning each get decided as
small ADR-sized commitments while the DIR-05 milestone is built, so the
data model grows toward multi-user shape continuously rather than being
retrofitted.

## Status log

- `2026-08-22` — created as a stub behind PLAN-041.
- `2026-08-22` — amended from product-owner review of PR #171: user awareness / access control / versioning land incrementally via ADRs + guiding principles.
