---
id: DIR-03
title: The Live Observatory
status: active
opened: 2026-04-28
related-discussions:
  - 2026-04-28-canvas-paradigm-directions.md
related-plans:
  - PLAN-005-webui-tailscale-launcher.md
  - PLAN-007-orchestration-activity-panel-done.md
  - PLAN-013-server-only-deployment.md
  - PLAN-023-hosted-workspace-server.md
  - PLAN-030-session-lifecycle-automation.md
  - PLAN-031-status-invariants-at-the-choke-point.md
  - PLAN-033-hermetic-config-dir-for-test-runs.md
  # The paused richer-progress / phase-1.5 orchestration plans are archived in
  # the private vorno-internal repo (see ADR-0006).
---

# Direction 3 — The Live Observatory

> *"Use dynamic interfaces to visualize the agentic work in Craft itself."*

## Thesis

Agents go from being *something you talk to* to *something you watch and conduct* when their work is rendered as a live spatial graph that you can move between devices.

We've already built the substrate without realizing it: the dual-transport server (HTTP/SSE + WebSocket) pushes events to any subscribed client, with `PushTarget` routing across `all`/`workspace`/`client`/`session` scopes. What's missing is the **observation surface** — a dedicated app that renders the in-flight work of all sessions across all clients as a tldraw graph.

## What it looks like

- Each session is a swim-lane or sub-canvas.
- Tool calls light up as nodes; complete = green, error = red, in-flight = pulsing.
- Permission requests float out as urgent shapes you can approve from the Observatory.
- Sources pulse when touched.
- Thinking blocks visible as ambient "thought clouds" you can hover-expand.
- You're not reading transcripts — you're standing in the operating room of your agent fleet.

## Architecture

- **New app**: `apps/observatory/` — Vite + React + tldraw, separate from the Electron desktop.
- **Connection**: existing `MessageEnvelope` WS protocol. The Observatory is just another client.
- **Cross-device sync**: Automerge for canvas layout state. Mobile, desktop, web see the same Observatory canvas.
- **Targeting reuse**: `pushToWorkspace` / `pushToSession` already exists. The Observatory subscribes to `workspace:*` and renders everything.
- **Composition with Direction 2**: skill-contributed shapes render in the Observatory too. The Observatory inherits the modality ecosystem for free.

## What this unlocks

1. **Operator-mode usage** — fire off three sessions, switch to Observatory, watch them work in parallel.
2. **Multi-device continuity** — leave your desk mid-run, observe and intervene from your iPad on the porch.
3. **Replay and history** — the same shape graph that's live can be persisted and replayed later. Debugging at a glance.
4. **Teaching and sharing** — a snapshot of an Observatory canvas is a much richer artifact than a transcript dump.

## Constraints / non-goals

- Depends meaningfully on Directions 1 and 2 — the shape vocabulary is shared.
- Not a v1 concern: production multi-tenancy. Observatory v0.1 is for a single user observing their own fleet.
- Not a replacement for the desktop shell. Different posture (observation vs. authoring).

## Open questions

- Authentication: Observatory connects via API key. Does it need its own permission policy? Probably read-only by default with explicit elevation for approve actions.
- Mobile-first design vs desktop-first? Probably tablet-first, then phone, then desktop.
- Storage: where does the Observatory canvas state live? Per-user `~/.craft-agent/observatory.automerge`?

## References

- Direction 1 (canvas substrate)
- Direction 2 (shape ecosystem)
- [Automerge](https://automerge.org)
- [Local-First Software essay](https://www.inkandswitch.com/local-first/)
