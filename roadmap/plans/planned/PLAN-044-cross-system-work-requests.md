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

## Salvaged from prior plans (PLAN-045 Pass 1)

The workspace-webhook plan this stub extends left behind a precise set of
answers and one named generalization. Collected here so expansion starts from
them.

**The async half already has its retry machinery — it just needs widening.**
`packages/shared/src/automations/retry-scheduler.ts` persists work across
restart on immediate → 5 m → 30 m → 1 h tiers, and PLAN-014 already named the
exact generalization: **carry a work-item union instead of only
`WebhookAction`.** An async work-request response is that work item.
← `PLAN-014-workspace-webhooks.md`

**Shipped contract shapes to inherit, not redesign**

- **`202` within ~100 ms regardless of executor latency** — the provider-facing
  response is decoupled from the work. That is the front half of the async
  lifecycle this stub describes.
- **Bad token, unknown slug, and unknown workspace are indistinguishable
  `404`s** — no oracle for probing which endpoints exist. Per-definition
  endpoints multiply the surface this protects.
- **`deferred: host-unreachable`** — when the target host cannot be reached,
  the record says *deferred*, not *ok*. A cross-system requester needs the same
  vocabulary.
- All ingest decisions and action results land in `automations-history.jsonl`
  with duplicate deliveries returning `200 {duplicate:true}` and executing
  nothing. ← `PLAN-014`

**Semantics the response channel must get right**

- **`ok` means dispatched, never achieved** (LEARNING-052). A "work complete"
  callback that actually means "we started it" is the defect this whole line of
  work exists to avoid. Automation history records only decisions the layer
  itself made or *structurally observed* — never agent behaviour inside a turn.
  A cross-system response inherits that rule or it lies to another system.
  ← `PLAN-030-session-lifecycle-automation.md`
- **Loop guards and provenance are not optional here.** PLAN-030 Phase 1
  shipped both for session actions on arbitrary events; a request that spawns
  work which emits a request cycles trivially and across a trust boundary.
  ← `PLAN-030`

**Gates and posture**

- **A public unauthenticated write endpoint needs a privacy policy first.**
  Dynamically-generated inbound webhooks that accept bodies of work from other
  systems are exactly that; Swagatar becomes data controller for whatever
  arrives. Legal gate, not a follow-up. ← `PLAN-035-vorno-hosted-session-shares.md`
- **Adopt-don't-invent has a precedent in this repo.** PLAN-027 lifted the
  host-side requirements of the ratified MCP Apps `ui/*` spec verbatim rather
  than designing a bridge. The A2A research task's "if it fits, align to it"
  is the same call, already made once.
  ← `PLAN-027-interactive-surfaces-mcp-apps-bridge.md`

**Known defect the per-definition endpoints will hit**

- Hooks whose only action is a session action (no prompt or outbound webhook)
  **do not appear in the parsed hook list** — the create flow defaults to a
  prompt action, which masks it for UI-created hooks. A definition-triggered
  endpoint has no prompt action by construction. ← `PLAN-014`

## Status log

- `2026-08-22` — created as a stub behind the DIR-05 milestone, from product-owner review feedback on PR #171 (cross-system work requests + A2A evaluation).
