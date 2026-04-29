---
id: PLAN-001
title: Canvas Session — spectator v0.1
status: in-progress
direction: DIR-01
owner: jh
created: 2026-04-28
updated: 2026-04-29
related: []
blocked-by: []
---

# PLAN-001 — Canvas Session — spectator v0.1

## Goal

Ship a feature-flagged, read-only canvas view of an active Craft session that renders the same `AgentEvent` stream the chat view consumes, as tldraw shapes connected by causal edges.

## Scope

- New renderer page/view: `CanvasSessionView`
- Three custom tldraw shape types:
  - `TextShape` — renders `text_complete` content
  - `ToolCallShape` — renders `tool_start` (collapsed) → expands to show tool, input, status
  - `ResultShape` — renders `tool_result` (reuses existing block renderers — html-preview, datatable, etc.)
- Causal edges:
  - `tool_start` ↔ `tool_result` paired by `tool_use_id`
  - `text_*` events anchored sequentially to the prior tool result
- Subscribed to the same EventBus / streaming source the chat view uses (no agent or server changes)
- Settings toggle: "Enable Canvas View (preview)"
- Layout: time-axis top-to-bottom on first paint; user drag is sticky (per-session sidecar `session.canvas.json`)
- Empty state: clear "no events yet" placeholder
- Smoke tests for shape registration and event-to-shape mapping

## Non-goals

- **No** writing back to the canvas (no agent-driven shape creation)
- **No** forking, branching, or re-running from a shape (deferred to v0.2)
- **No** Automerge / multiplayer (Direction 3)
- **No** mobile rendering optimization
- **No** zoom-into-modality interactions (deferred)
- **No** changes to upstream-shared agent core, server, or `MessageEnvelope` protocol

## Approach

```mermaid
graph LR
  ES[AgentEvent stream<br/>existing EventBus] --> EM[EventMapper<br/>event → shape]
  EM --> SR[ShapeRegistry<br/>tldraw custom shapes]
  SR --> CV[CanvasSessionView<br/>tldraw editor]
  CV --> SC[Sidecar layout<br/>session.canvas.json]
  Settings[Setting:<br/>canvasView=true] --> CV
```

**Stack**:

- `@tldraw/tldraw` — canvas SDK (BSD-3-style "tldraw license"; verify acceptable)
- Existing block renderers (`html-preview`, `datatable`, etc.) embedded inside `ResultShape`'s component
- New file layout:
  - `apps/electron/src/renderer/pages/CanvasSessionPage.tsx` — page entry
  - `apps/electron/src/renderer/components/canvas/CanvasSession.tsx` — main editor
  - `apps/electron/src/renderer/components/canvas/shapes/` — shape definitions
  - `apps/electron/src/renderer/components/canvas/event-mapper.ts` — event → shape pipeline
  - `apps/electron/src/renderer/components/canvas/__tests__/` — bun tests

**Risks**:

- tldraw bundle size (~600 KB gzipped). Acceptable for desktop, defer mobile concern.
- License compatibility with our distribution model — check before committing.
- Embedding rich block renderers inside tldraw shapes (tldraw shapes render via React; should be straightforward but worth a spike).

## Acceptance

- [ ] tldraw installed; license reviewed
- [ ] `CanvasSessionView` mounts inside the app shell behind `settings.canvasView` flag
- [ ] Three shape types render correctly for a sample session
- [ ] Causal edges drawn for tool_start → tool_result pairs
- [ ] Layout persists to `session.canvas.json` on user drag
- [ ] Setting toggle exposed in Settings → Appearance (or similar)
- [ ] At least one screenshot in PR description
- [ ] Bun tests for `event-mapper.ts` (covers each event type)
- [ ] Direction doc updated with v0.1 outcome (`directions/01-canvas-session.md`)
- [ ] Plan moved to `done/` (then `documented/` after release notes)

## Status log

- `2026-04-28` — created in `planned/`
- `2026-04-29` — moved to `in-progress/`; branch `jh/canvas-session-spectator-v0` opened
