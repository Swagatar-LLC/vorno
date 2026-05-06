---
id: DIR-01
title: The Canvas Session
status: active
opened: 2026-04-28
related-discussions:
  - 2026-04-28-canvas-paradigm-directions.md
related-plans:
  - PLAN-001-canvas-session-spectator-v0.md
---

# Direction 1 — The Canvas Session

> *"The chat is a canvas now."*

## Thesis

A Craft session is currently rendered as a vertical scroll of messages. It does not need to be. The session's underlying data — a stream of `AgentEvent` objects — is **already a graph of causally-linked artifacts**. We've been flattening it into a transcript by convention, not necessity.

If we project the same `AgentEvent` stream onto a [tldraw](https://tldraw.dev) canvas, every event becomes a shape, every causal link becomes an edge, and the conversation becomes **malleable spatial data**. The user can drag, fork, annotate, zoom, and treat the session as a living workspace rather than a transcript to scroll past.

## Mapping

| `AgentEvent` type      | Canvas shape                                                  |
|------------------------|---------------------------------------------------------------|
| `text_delta` / `text_complete` | Speech-bubble or note shape, edge from causing tool   |
| `tool_start`           | Node-shape with input fields visible                          |
| `tool_result`          | Embed-shape rendering existing html-preview/datatable/etc.    |
| `permission_request`   | Interactive shape with inline Approve/Deny                    |
| `thinking_delta`       | Faded "scratchpad" shape, auto-collapses                      |
| `complete` / `error`   | Terminator shape closing the run lane                         |

User-added shapes (sticky notes, drawings, embeds, dropped files) become first-class context the agent reads back via the existing source/file mechanisms.

## What this unlocks

1. **Spatial reasoning over agent runs** — drag a tool result aside, label it, group related calls, reflow.
2. **Forking** — select a shape, "fork from here," continue the agent in a parallel sub-canvas.
3. **Zoom-into-modality** — datatables become full spreadsheets, mermaid becomes editable, embedded HTML becomes inspectable.
4. **Branching chat** — the tldraw branching-chat starter kit applies directly.
5. **Multiplayer/spectator** — the dual-transport server already pushes events to any subscribed client. Two devices can watch the same canvas in real time.

## Architecture

- **Reuse, don't rebuild.** The `AgentEvent` stream is the source of truth. The canvas view subscribes to the existing `EventBus`.
- **Custom shape types in tldraw.** One per event type, each rendering the existing chat block as its content.
- **Causality edges** are derived from event ordering and tool-call IDs — no new metadata yet.
- **Read-only first.** v0.1 is spectator mode: the canvas reflects the session, but interactions land back in the chat. Read/write integration follows once the projection is solid.
- **Feature-flagged.** The chat surface stays default. Canvas view is an opt-in toggle (or split-pane).

## v0.1 scope (PLAN-001)

The smallest credible version:

- One new renderer page/view: `CanvasSessionView`
- Three shape types: `TextShape`, `ToolCallShape`, `ResultShape`
- Edges by tool-call ID and event sequence
- Subscribed to existing `AgentEvent` stream
- Toggle flag in app settings
- Zero changes to agent core, server, or protocol

Estimated 3–4 focused days of work.

## Constraints / non-goals

- **Not** a chat replacement in v0.1 — strictly additive.
- **No** new agent capabilities yet (Direction 2 covers that).
- **No** Automerge / multiplayer in v0.1 (Direction 3 covers that).
- Mobile rendering deferred — desktop electron only at first.

## Open questions

- Layout algorithm: time-axis (top-to-bottom) vs causal DAG vs free-form? Probably time-axis on first paint, free-form after user drag.
- Persistence: do we store canvas layout per session in a sidecar file? `session.canvas.json`?
- How do we handle long sessions (1000+ events)? Virtualized rendering or summary-collapsing.

## SDK choice

The dossier originally recommended [tldraw](https://tldraw.dev). On 2026-04-29 we discovered tldraw 4.x is no longer Apache-2.0 — its custom license prohibits Production Environment use, which our distribution qualifies as.

**For v0.1 we use [React Flow / xyflow](https://reactflow.dev) (MIT).** The session-as-causal-graph framing fits React Flow's wheelhouse exactly. See [ADR-0004](../decisions/0004-canvas-sdk.md) for the full rationale and the analysis discussion at [`discussions/2026-04-29-canvas-sdk-license.md`](../discussions/2026-04-29-canvas-sdk-license.md).

This choice is local to v0.1 and revisitable as Directions 2 and 3 develop.

## References

- [React Flow / xyflow](https://reactflow.dev) — selected SDK (v0.1)
- [tldraw SDK](https://tldraw.dev) — original recommendation (license-incompatible at v4.x)
- [Obsidian JSON Canvas spec](https://jsoncanvas.org)
