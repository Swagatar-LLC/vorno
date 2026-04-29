---
id: ADR-0003
title: Canvas as the paradigm direction
status: accepted
date: 2026-04-28
supersedes: []
superseded-by: []
---

# ADR-0003 — Canvas as the paradigm direction

## Context

The fork was created to push toward a "dynamic workspaces" paradigm — an open extensible shell for AI-native work that replaces siloed apps with a multimodal infinite canvas. The 2026-04-28 research dossier ([discussion](../discussions/2026-04-28-canvas-paradigm-directions.md)) surveyed the field and identified the gap: *no open product combines extensible canvas + first-class AI orchestration + cross-platform local-first sync*.

We need a coherent program direction beyond ad-hoc feature work.

## Decision

We commit to the **three-layer canvas program**:

1. **Direction 1 — The Canvas Session.** Project the existing `AgentEvent` stream onto a tldraw canvas. Spectator mode first, then read/write. ([DIR-01](../directions/01-canvas-session.md))
2. **Direction 2 — Skills as Contribution Points.** Extend `SKILL.md` into a contribution manifest registering custom shapes, tools, and views. ([DIR-02](../directions/02-skill-contributions.md))
3. **Direction 3 — The Live Observatory.** A separate app that renders all sessions as a live spatial graph, local-first across devices. ([DIR-03](../directions/03-observatory.md))

Each direction is independently shippable and additive. None of them break upstream wire compatibility.

## Consequences

### Positive

- We have a coherent narrative for why we're forking and what the end state looks like.
- Direction 1 reuses the existing `AgentEvent` substrate — fast to ship, no protocol changes, low blast radius.
- Direction 2 unlocks third-party modalities; the value compounds with each contributed skill.
- Direction 3 turns existing dual-transport infrastructure into a multi-device observability story.

### Negative

- We commit (loosely) to tldraw as the canvas SDK. Switching later is possible but expensive.
- We add a new product surface (canvas) before the existing one (chat) is fully matured. Risk of split focus — mitigated by feature-flagging.
- Direction 3 implies eventually adopting Automerge or Yjs. That's a significant new dependency we haven't ratified yet (will require a new ADR).

### Neutral

- The directions may rebalance as we learn. Direction docs are living; this ADR fixes only the *commitment to the three-layer program*, not the specifics of each layer.

## Alternatives considered

- **Improve chat UX only.** Rejected: doesn't move toward the paradigm vision; upstream covers this adequately.
- **Build a node-editor product (ComfyUI clone).** Rejected: too narrow; loses the multimodal canvas thesis.
- **Skip Direction 1, jump to Direction 3.** Rejected: Direction 3 needs the shape vocabulary Directions 1 and 2 establish.

## References

- [VISION.md](../VISION.md)
- [Direction 1](../directions/01-canvas-session.md)
- [Direction 2](../directions/02-skill-contributions.md)
- [Direction 3](../directions/03-observatory.md)
- [Canvas paradigm directions discussion (2026-04-28)](../discussions/2026-04-28-canvas-paradigm-directions.md)
