# Vision

## What we're building

An **open, extensible shell for AI-native dynamic workspaces** — a paradigm shell that replaces siloed apps with an open canvas of pluggable modalities, AI agents, and novel UI. Multimodal, cross-platform, local-first, agent-orchestrated.

We are starting from Craft Agents (an excellent AI-native workflow chat surface) and growing it toward this paradigm.

## The paradigm shift

Today, even good AI tools treat conversations as transcripts and tools as opaque function calls. We believe:

1. **A session is a workspace, not a transcript.** Tool calls, results, and reasoning are first-class spatial artifacts the user can rearrange, fork, annotate, and zoom into.
2. **Skills are the unit of malleable software.** Third parties ship not just instructions but new shapes, new tools, new views — composable on the same canvas.
3. **Agents are observable, not opaque.** A live, multi-perspective view of agentic work — sessions as swim lanes, tool calls lighting up, permission requests floating out — turns operators into conductors.
4. **Local-first by default.** Workspaces travel across devices. Work continues offline. Sync is a CRDT, not a server round-trip.

## Why Craft Agents is the right starting point

The dossier ([`discussions/2026-04-28-canvas-paradigm-directions.md`](discussions/2026-04-28-canvas-paradigm-directions.md)) surveyed the field. The closest thing to this vision that exists today is *Obsidian + tldraw + ComfyUI + VS Code extensibility + Automerge sync, rethought from scratch around AI-native workflows.*

Craft Agents already provides:

- A streaming `AgentEvent` model — the substrate for canvas events
- Dual-transport server (HTTP/SSE + WebSocket) with multi-client push
- Sources and skills systems (we extend skills into contribution points)
- Rich render blocks (html-preview, datatables, mermaid, pdf-preview)
- A working desktop shell to evolve

So we don't start from zero. We grow it.

## Strategic directions

Layered bets — each independently shippable, each enables the next. See [`directions/`](directions/) for full statements.

1. **Dynamic Workspaces** — every workspace output (and every UI surface) is a typed, versioned, related artifact; surfaces are generated compositions of trusted blocks, with a ratified-standard escape hatch for expressive apps. *(Direction 4, near-term — the current active build, ADR-0015)*
2. **The Canvas Session** — every `AgentEvent` is a shape on a tldraw canvas, projected from the artifact plane. *(Direction 1, mid-term)*
3. **Skills as Contribution Points** — skills register surface templates, artifact types, and views via a manifest. The third-party modality ecosystem opens. *(Direction 2, mid-term)*
4. **The Live Observatory** — a separate app that renders all sessions across all clients as a live spatial graph. Local-first via Automerge. *(Direction 3, longer-term)*

## Principles

- **Wire-compatible with upstream** as long as feasible. The `MessageEnvelope` protocol is a contract.
- **Contribute portable improvements upstream.** We won't horde useful work.
- **Ship behind feature flags.** New paradigms enter as opt-in, not replacements.
- **One PR, one idea.** Small, reviewable, revertible.
- **The roadmap is the codebase.** Plans live in this repo; folder moves are the workflow.

## What we won't do (yet)

- We won't replace upstream's chat UX wholesale. The canvas is a *new* surface alongside, not a swap.
- We won't fork the protocol unless we've exhausted upstream-compatible alternatives.
- We won't build voice as a 0-to-1 modality before Direction 1 lands. Voice belongs naturally inside the canvas paradigm later.
- We won't optimize for scale before we've validated the paradigm with a small, devoted user base (initially: us).

## North stars

- [Ink & Switch](https://inkandswitch.com) — the intellectual lab doing this thinking longer than anyone.
- [tldraw](https://tldraw.dev) — the canvas SDK we'll most likely build on.
- [Bret Victor's Dynamicland](https://dynamicland.org) — the philosophical horizon.
- The VS Code contribution model — the proven blueprint for safe extensibility.

## Cadence

- **Roadmap review** monthly: archive stale plans, refresh upstream tracking, prune discussions.
- **Upstream merge** weekly when upstream is active; otherwise on each release tag.
- **Direction review** quarterly: are we still aimed at the right thing?
