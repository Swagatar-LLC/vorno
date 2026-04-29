---
date: 2026-04-29
participants: [jh, claude-opus]
topic: Canvas SDK license blocker
related-decisions: [ADR-0004]
related-plans: [PLAN-001]
related-directions: [DIR-01]
---

# Canvas SDK license blocker — 2026-04-29

## Context

PLAN-001 starts the spectator Canvas View. The original design assumed [tldraw](https://tldraw.dev) as the canvas SDK (per the 2026-04-28 dossier).

## Finding

**tldraw 4.x ships under a custom restrictive license**, not Apache-2.0. Verified directly from `tldraw/main/LICENSE.md`:

> **Not to use the Software in Production Environments.**
> "Production Environment" means any production deployment of the Software that operates on servers, cloud platforms, web applications, or where the software is used to provide functionality to end users, customers, or the public.

> **Not to make the Software available under a license that supersedes or negates the effect of this License.**

Our fork is **Apache-2.0**, distributed to end users via the Electron desktop app. By the tldraw license's definition, this is a Production Environment. Including tldraw under our Apache-2.0 distribution would violate both the Production Environment clause and the "no superseding license" clause.

## Why it changed

tldraw 2.x was Apache-2.0. The custom "tldraw license" was introduced around tldraw 3.x (mid-2024) to enable a sustainable business model around the SDK. tldraw 4.5.10 (current) continues and tightens this license.

## Options

### Option A — React Flow / xyflow (MIT)

[reactflow.dev](https://reactflow.dev) — the most mature, widely-used, MIT-licensed node-UI library.

**Pros:**
- MIT — fully compatible with Apache-2.0 distribution.
- Purpose-built for node + edge UIs. Maps cleanly to our `tool_start` → `tool_result` causality.
- Strong custom node API. Each `AgentEvent` shape becomes a custom node type with full JSX rendering.
- Infinite canvas, pan/zoom, mini-map, drag, multi-select — all built in.
- Active maintenance, well-documented.

**Cons:**
- Less "free-form" than tldraw — best for graph-shaped data, not arbitrary drawing/sketching. For Direction 1 v0.1 this is *fine* (sessions are graph-shaped). For Direction 2's custom modalities (DAW, 3D), we may want a more general substrate eventually.
- No built-in handwriting/sketching, no shaders, no built-in multiplayer (we have our own WS layer anyway).

**v0.1 fit:** Excellent. The session-as-graph framing is *exactly* React Flow's wheelhouse.

### Option B — Excalidraw (MIT)

[excalidraw.com](https://excalidraw.com) — hand-drawn aesthetic, MIT, infinite canvas.

**Pros:**
- MIT.
- Free-form canvas (closer to tldraw's posture).
- Embeddable as a component.

**Cons:**
- Custom-shape API is less polished than tldraw's; tighter, less documented.
- Aesthetic is opinionated (sketchy strokes) — may not fit our chrome.
- Less natural for node-graph rendering than React Flow.

### Option C — Build minimal on react-zoom-pan-pinch + custom React

**Pros:**
- Zero license entanglement.
- Minimal dependency footprint.
- Full control.

**Cons:**
- Significant up-front work (drag, snapping, edges, layout) — re-builds wheels.
- Slows v0.1 substantially.

### Option D — tldraw with paid license

Pricing varies; commercial license required for production distribution.

**Pros:**
- The dossier's preferred SDK.
- Best DX once we're paying.

**Cons:**
- Cost (likely $$/month minimum tier).
- Locks us to a vendor relationship before we've validated the paradigm.
- Still a custom license — may complicate distribution to OSS contributors.

### Option E — tldraw 2.x (last Apache-2.0 version)

**Pros:**
- Apache-2.0; legally clean.

**Cons:**
- No longer maintained on that branch.
- Older API; less tested with React 19, modern Electron.
- We'd be carrying an unmaintained dep through Direction 1, 2, 3.

## Recommendation

**Adopt Option A (React Flow) for Direction 1 v0.1.**

Rationale:

1. **License**: MIT, no entanglement, perfect Apache-2.0 fit.
2. **Fit-to-task**: PLAN-001 is fundamentally a node-graph render of `AgentEvent` causality. React Flow is purpose-built for this. We don't need free-form canvas affordances in v0.1.
3. **Speed**: scaffolding a React Flow custom-node visualization is faster than tldraw was going to be, because we don't fight a generic shape system.
4. **Future flexibility**: when Direction 2's custom shapes need free-form canvas (music DAW, 3D scenes), we can either compose React Flow with another lib, swap to a maintained permissive alternative, or revisit a paid tldraw license once the paradigm is validated.

We update DIR-01 and PLAN-001 to name React Flow as the v0.1 SDK, with a note that the choice is local to v0.1 and revisitable.

## Acknowledgments

The 2026-04-28 dossier preceded our license check. The dossier's recommendation was correct under the assumption tldraw was permissively licensed; the assumption no longer holds at version 4.x. Strategic intent (canvas-as-substrate) is unchanged — only the SDK changes.
