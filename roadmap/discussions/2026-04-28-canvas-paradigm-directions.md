---
date: 2026-04-28
participants: maintainer + agent
topic: Canvas paradigm directions
related-decisions: [ADR-0003]
related-directions: [DIR-01, DIR-02, DIR-03]
related-plans: [PLAN-001]
---

# Canvas paradigm directions — 2026-04-28

## Context

After the v0.8.10 → v0.8.12 upstream merge, we paused to ask the strategic question:

> Take the research dossier on dynamic workspaces and propose 3 integration directions, assuming we'll use Craft to create dynamic interfaces *and* use dynamic interfaces to visualize the agentic work in Craft itself.

The supporting dossier is the HTML research artifact:
[`/attachments/86dacd57-…_Workspace Research - Claude.html`](../../attachments/86dacd57-e280-431f-900b-05fb9dc8ef07_Workspace%20Research%20-%20Claude.html)
*(Note: the attachment lives in the session folder, not this repo. Mirror to `roadmap/discussions/_attachments/` if we want it permanent.)*

## Dossier — key findings

The closest thing to the paradigm that exists today is *Obsidian + tldraw + ComfyUI + VS Code extensibility + Automerge sync, rethought from scratch around AI-native workflows.* Every component part is mature and open source. Nobody has put them all together.

Four anchors worth attention first:

1. **tldraw SDK** — the clearest canvas foundation: open-source React, custom shapes/tools/bindings, official starter kits for AI agents, node workflows, branching chat, multiplayer, shaders.
2. **Ink & Switch** — research lab on malleable software, programmable ink, local-first.
3. **VS Code extension model** — the proven blueprint for "dynamic environment with multiple UI modalities" (contribution points + sandboxed webviews + extension host).
4. **Automerge / Yjs** — production-grade CRDTs for the cross-device sync layer.

Open territory: *open extensible shell where third parties ship new modalities (node editor, DAW, 3D scene, code editor, spreadsheet) that compose on the same canvas, with first-class AI orchestration across all of them, and cross-platform local-first sync.* Pick any three and you'll find a product. All four together: nobody.

## What Craft already provides

- `AgentEvent` streaming model — substrate for canvas events
- Dual-transport server (HTTP/SSE + WebSocket) with `PushTarget` routing
- Sources and skills systems
- Rich render blocks (html-preview, datatables, mermaid, pdf-preview, image-preview)
- Working desktop shell (Electron + Vite + React + Jotai + Tailwind)

We don't start from zero. We grow it.

## The three directions

### Direction 1 — The Canvas Session

> *"The chat is a canvas now."*

Re-imagine a session not as a transcript but as a tldraw canvas where every `AgentEvent` is a shape. `tool_start` → node-shape, `tool_result` → embed-shape rendering existing render blocks, `text_delta` → speech-bubble linked by causal edge. User-added shapes (notes, drawings, files) become first-class context.

What this unlocks: spatial reasoning, forking, zoom-into-modality, branching, multiplayer/spectator.

Cost is low: reuses existing `AgentEvent` stream, render blocks become shape contents, WebSocket push handles cross-client canvas ops for free.

→ **Captured as [DIR-01](../directions/01-canvas-session.md), first plan [PLAN-001](../plans/planned/PLAN-001-canvas-session-spectator-v0.md).**

### Direction 2 — Skills as Contribution Points

> *"VS Code's contribution model, rethought around AI-native modalities."*

Today a `SKILL.md` ships instructions. Extend its frontmatter into a contribution manifest registering custom shapes, custom tools, custom views. Skills become the unit of malleable software.

ComfyUI's lesson: *a community will build thousands of specialized nodes if the plugin API is clean.* Ship the smallest possible surface — start with one contribution point (`customShape`) and prove the loop.

→ **Captured as [DIR-02](../directions/02-skill-contributions.md).**

### Direction 3 — The Live Observatory

> *"Use dynamic interfaces to visualize the agentic work in Craft itself."*

A separate app (`apps/observatory/`) connects to any Craft server and renders the live state of every session across the workspace as a spatial graph. Each session a swim lane. Tool calls light up. Permission requests float out as approvable shapes. Local-first via Automerge so it works on mobile/web/desktop.

→ **Captured as [DIR-03](../directions/03-observatory.md).**

## Layering

```
AgentEvent stream (existing)
        │
        ▼
[DIR-01] Canvas Session — events as shapes
        │
        ▼
[DIR-02] Skill Contributions — extensible shape/tool/view registry
        │
        ▼
[DIR-03] Observatory — multi-session, multi-device, local-first
        │
        ▼
Open territory: canvas + extensibility + local-first + multimodal
```

Each direction is independently shippable. The Observatory inherits the modality ecosystem from Direction 2 for free.

## Recommended next concrete step

**Direction 1 in spectator mode**, behind a feature flag. Lowest risk, highest paradigm payoff:

- Reuses the `AgentEvent` stream — no new protocol
- Ships as a side-by-side view — chat still works
- Validates the core insight (the conversation is malleable spatial data, not a transcript)
- Unlocks Directions 2 and 3 without committing to either yet

→ **Operationalized as [PLAN-001](../plans/planned/PLAN-001-canvas-session-spectator-v0.md).**

## Outcomes from this discussion

- Adopted three-direction program — see [ADR-0003](../decisions/0003-canvas-as-paradigm-direction.md).
- Created roadmap governance system — see [ADR-0002](../decisions/0002-roadmap-folder-status-workflow.md).
- Affirmed wire-compatible-but-deliberately-divergent fork posture — see [ADR-0001](../decisions/0001-fork-relationship-with-upstream.md).
