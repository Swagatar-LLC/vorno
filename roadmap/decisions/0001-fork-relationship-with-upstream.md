---
id: ADR-0001
title: Fork relationship with upstream
status: accepted
date: 2026-04-28
supersedes: []
superseded-by: []
---

# ADR-0001 — Fork relationship with upstream

## Context

We are a fork of [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss) hosted at [Swagatar-LLC/craft-agents-oss](https://github.com/Swagatar-LLC/craft-agents-oss). Upstream is actively developed (releases roughly weekly). We have non-trivial original work landed (HTTP trigger server, dual-transport WebSocket, governance system, canvas paradigm direction).

We need a clear posture toward upstream so future merges, contributions, and divergences are deliberate rather than accidental.

## Decision

We adopt a **wire-compatible, deliberately-divergent** posture:

1. **Sync with upstream on every release tag.** A scheduled `[skill:upstream-sync]` workflow handles the mechanical merge.
2. **Stay wire/protocol compatible** with upstream's `MessageEnvelope`, `AgentEvent`, source/skill conventions, and CRDT contracts (when added). Breaking these requires a new ADR.
3. **Contribute portable improvements upstream** when value is clear and our maintenance cost is lower outside our fork. Tracked in `roadmap/upstream/contribution-candidates.md`.
4. **Diverge deliberately** on direction (canvas paradigm, contribution model, observability) where upstream's roadmap doesn't align. Diverged code lives in `apps/server/`, the new canvas surface, the contribution registry, etc. — clearly separated from upstream packages.
5. **Track our owned diffs** in `roadmap/upstream/delta.md`. Refreshed on every upstream sync via `[skill:upstream-delta-report]`.

## Consequences

### Positive

- Users of our fork can swap to upstream (or vice versa) at the protocol layer without re-integrating.
- We can move fast on direction without forking the protocol.
- Contribution-candidate tracking gives us a clear path to upstream PRs without losing context.

### Negative

- Every upstream merge requires resolving our `bun.lock`, `options.ts`, and any other touchpoints. We've mechanized this into a skill, but it's ongoing tax.
- Some of our code (e.g., the HTTP trigger server) has evolved past upstream's nascent equivalents. If upstream ships an alternative, we may face a decision: re-converge or stay diverged.

### Neutral

- We carry the upstream history in our git log permanently. Acceptable; informative.

## Alternatives considered

- **Hard fork** (no upstream sync). Rejected: upstream improvements are valuable and we'd lose the wire-compatible audience.
- **Upstream-first** (only ship what's PR-able to upstream). Rejected: precludes paradigm bets like the canvas direction that upstream is unlikely to accept.
- **Vendor as a dependency** (use upstream as an npm dep, layer additions). Rejected: too restrictive — we need to modify shared internals occasionally.

## References

- [`roadmap/upstream/`](../upstream/)
- [`.agents/skills/upstream-sync/`](../../.agents/skills/upstream-sync/)
- [`.agents/skills/upstream-delta-report/`](../../.agents/skills/upstream-delta-report/)
