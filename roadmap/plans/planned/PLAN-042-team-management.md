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

## Salvaged from prior plans (PLAN-045 Pass 1)

- **Attribution has a shipped home already — extend it, don't parallel it.**
  `StatusChangeOrigin` (`agent` / `user` / `host` / `automation`) is enforced at
  the `SessionManager.setSessionStatus` choke point, defaults fail-closed, and
  encodes exactly the authority question this plan asks ("who may close, who may
  approve"). A multi-user principal threads *into* that discriminator; a second
  authority model beside it would recreate the "asserted in three places,
  enforced in one" shape the fork spent a plan removing.
  ← `PLAN-031-status-invariants-at-the-choke-point.md`, ADR-0021
- **The single-user→multi-user seam is already drawn.** PLAN-023 Phase 0 was
  required to show where a user principal would thread through `bootstrapServer`
  handler deps and `SessionManager` *without reshaping today's single-token
  path* — and to resist designing multi-user code. That constraint ("the
  architecture must not preclude it," not "build it") is the same posture this
  stub takes, and its output lives in `docs/hosted-workspace-architecture.md`.
  ← `PLAN-023-hosted-workspace-server.md`

## Status log

- `2026-08-22` — created as a stub behind PLAN-041.
- `2026-08-22` — amended from product-owner review of PR #171: user awareness / access control / versioning land incrementally via ADRs + guiding principles.
