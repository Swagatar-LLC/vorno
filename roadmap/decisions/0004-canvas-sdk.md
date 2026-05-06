---
id: ADR-0004
title: Canvas SDK choice — React Flow for Direction 1 v0.1
status: accepted
date: 2026-04-29
supersedes: []
superseded-by: []
---

# ADR-0004 — Canvas SDK choice — React Flow for Direction 1 v0.1

## Context

[Direction 1 (Canvas Session)](../directions/01-canvas-session.md) and [PLAN-001](../plans/in-progress/PLAN-001-canvas-session-spectator-v0.md) require a canvas/graph-rendering SDK. The 2026-04-28 dossier recommended [tldraw](https://tldraw.dev). On 2026-04-29, while preparing the install, we discovered that tldraw 3.x and 4.x ship under a custom restrictive license that prohibits use in Production Environments — including distribution to end users via our Electron desktop app. Our fork is Apache-2.0; including tldraw 4.x would be license-incompatible.

Full analysis: [`discussions/2026-04-29-canvas-sdk-license.md`](../discussions/2026-04-29-canvas-sdk-license.md).

## Decision

**For Direction 1 v0.1, we adopt [React Flow / xyflow](https://reactflow.dev) (MIT) as the canvas SDK.**

This decision is **scoped to v0.1**. Direction 2 (custom-shape ecosystem) and Direction 3 (Observatory) may require a different or additional SDK; that's a separate ADR.

## Consequences

### Positive

- License-clean. MIT compatible with Apache-2.0 distribution.
- Excellent fit for v0.1: PLAN-001 renders `AgentEvent` causality as a node graph — exactly React Flow's primary use case.
- Faster to scaffold than tldraw would have been; React Flow's custom-node API is straightforward.
- Mature, widely used, actively maintained.

### Negative

- React Flow is graph-focused, not free-form canvas. If Direction 2 needs arbitrary drawing/sketching, we'll need to compose or swap. Acceptable — Direction 2 hasn't begun and we'll re-decide then.
- We give up tldraw's branching-chat / agent / shader starter kits. Those were inspirational, not load-bearing for v0.1.
- The Observatory (Direction 3) may want free-form canvas affordances for swim-lane layout. Re-evaluate when Direction 3 starts.

### Neutral

- Carry one dep: `@xyflow/react`. Reasonable footprint.

## Alternatives considered

- **tldraw 4.x with paid commercial license** — defers the cost question without validating the paradigm; rejected for v0.1.
- **tldraw 2.x (last Apache-2.0)** — unmaintained branch; rejected.
- **Excalidraw (MIT)** — less node-graph idiomatic; rejected for v0.1.
- **Hand-built on react-zoom-pan-pinch** — significant up-front work; rejected for v0.1.

## References

- [`discussions/2026-04-29-canvas-sdk-license.md`](../discussions/2026-04-29-canvas-sdk-license.md)
- [DIR-01](../directions/01-canvas-session.md) (updated)
- [PLAN-001](../plans/in-progress/PLAN-001-canvas-session-spectator-v0.md) (updated)
- [React Flow license](https://github.com/xyflow/xyflow/blob/main/LICENSE)
