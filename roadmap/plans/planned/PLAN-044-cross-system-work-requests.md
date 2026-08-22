---
id: PLAN-044
title: Cross-system work requests — inbound webhooks for bodies of work, A2A evaluation (STUB)
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-014-workspace-webhooks.md (shipped foundation — the webhook architecture this extends)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md (a definition is the thing a request would instantiate)
  - PLAN-041-server-homed-instances-with-auth.md (auth/identity home for OIDC-protected webhooks)
blocked-by:
  - PLAN-039
---

# PLAN-044 — Cross-system work requests *(stub)*

> **Stub.** Deliberately unscoped, staged behind the DIR-05 milestone. It exists
> so the workflow-definition identity model (PLAN-039 W1) anticipates *requests
> arriving from outside the workspace* — from other departments, other systems,
> other agent runtimes. Do not start; the one exception is the research task
> below, which can run any time.

## Sketch

Once a workflow definition exists as a holdable object (PLAN-039), the natural
external surface is: **dynamically generate an inbound webhook that "asks for a
body of work"** — a caller submits a request against a definition, a bound
instance is created and run, and the caller receives an **asynchronous
response** when the work completes (or as it progresses).

- **Transport:** the existing workspace-webhook architecture (PLAN-014) already
  provides per-workspace inbound HTTP with secret-path routing and automation
  fan-out; this plan extends it with *per-definition* endpoints and a response
  channel, rather than inventing a new listener.
- **Auth:** dynamic webhooks eventually carry **OIDC** (caller identity, not
  just a secret URL). That lands with PLAN-041's instance auth work — identity
  is an instance concern, not a webhook concern.
- **Async responses:** callback URL, polling, or a standard protocol — which is
  exactly what the research task must answer.

## First task (research — not blocked)

- [ ] **Evaluate the A2A (Agent-to-Agent) protocol** for the async
  request/response lifecycle: task objects, status updates, artifacts,
  long-running-task semantics, and its auth story. Deliverable: a
  `roadmap/research/` dossier answering (a) does A2A's task lifecycle map onto
  a Vorno workflow instance cleanly, (b) what subset would we implement as a
  *server* (receiving work) vs a *client* (requesting work), (c) does aligning
  cost us anything the plain-webhook path wouldn't. **If it fits, align to it**
  — a standards-aligned surface is worth more than a bespoke one (same posture
  as ADR-0017's standards-stack bias).

## Status log

- `2026-08-22` — created as a stub behind the DIR-05 milestone, from product-owner review feedback on PR #171 (cross-system work requests + A2A evaluation).
