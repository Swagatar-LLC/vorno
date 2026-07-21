---
id: DIR-04
title: Dynamic Workspaces — the artifact plane and the surface plane
status: active
opened: 2026-07-21
related-decisions:
  - 0015-two-plane-artifact-surface-architecture.md
related-plans:
  - PLAN-025-artifact-plane-v1.md
  - PLAN-026-composed-surfaces-v1.md
  - PLAN-027-interactive-surfaces-mcp-apps-bridge.md
---

# Direction 4 — Dynamic Workspaces: the artifact plane and the surface plane

> *"A surface is an artifact."*

## Thesis

Everything a Vorno workspace produces — session plans, datasets, governance docs, diagrams, and the UI surfaces that render them — is an **artifact**: typed, versioned (content-hash + git SHA), related (derivation, reference, rendering), and organized with **zero manual acquisition** (the index is context-aware: session, project, label, status). On top of that plane, surfaces are **generated, not hand-built**: an agent emits a declarative composition of the trusted block catalog (reliability-first) or, where expressivity demands it, a sandboxed HTML app speaking the ratified MCP Apps `ui/*` contract. Because each surface is itself an artifact, organization and rendering are one architecture, not two projects.

This direction operationalizes the VISION's "open, extensible shell for AI-native dynamic workspaces" through the ladder ADR-0015 ratified:

| Phase | Delivers | Plan |
|---|---|---|
| **C1** | Artifact plane, thin: `vorno:artifacts:*`, open type registry, context-aware zero-config index, relations, Artifact Home; JSON Canvas + frontmatter as native formats; Obsidian file-native projection | PLAN-025 |
| **C2** | Composed surfaces: versioned declarative spec over the existing block catalog, one generic host page, surfaces persisted as artifacts, round-trip v0 | PLAN-026 |
| **C3** | Interactive surfaces: `allow-scripts` sandbox class + postMessage bridge aligned to MCP Apps SEP-1865 | PLAN-027 |
| **C4** | Opportunistic: external first-class integrations, DIR-02 skill contributions targeting the surface spec, canvas projection | future |

## Relationship to the other directions

- **DIR-01 (Canvas Session):** the canvas becomes a *projection* of the artifact plane. C1's JSON Canvas artifact type prefigures it; the spatial act consumes this plane's index and relations rather than inventing its own substrate.
- **DIR-02 (Skill Contributions):** contribution points get concrete targets — surface templates, artifact types, block renderers — once C2's spec and C1's registry are stable. The `contributes:` frontmatter seam is verified zero-migration. Deferred to C4 to avoid building the registry before the things it registers.
- **DIR-03 (Observatory):** an observatory is a composed surface over live session artifacts — a future consumer, not a prerequisite.

## Design tenets (from ADR-0015)

1. Zero-config, context-aware artifact acquisition; manual configuration is an advanced override.
2. Blandness > jank: trusted composed surfaces are the default class; expressive HTML apps are the escape hatch.
3. Adopt open specs at code level (MCP Apps `ui/*`, JSON Canvas v1.0, frontmatter conventions) — invent only where no standard exists.
4. External integrations are first-class interactive clients or not built.
5. Interaction quality is a design principle: auto-save, responsive state, pickers over free-text config.
6. Catalog gaps to close deliberately: editable graphs/diagrams, editable datagrids, smart chips.

## Working vocabulary (non-binding)

*Workflow* = a process that moves material · *Workbench* = where a workflow happens (one surface type) · *Workspace* = the collection of workbenches material moves through. Orientation for naming as surfaces multiply — not a commitment to a single framing.

## References

- ADR-0015 (the ratifying decision; full context and owner rulings)
- Options analysis: session 260721-fleet-spring `plans/artifact-surfaces-direction-options.md`
- ADR-0014 / PLAN-024 (the workbench — first surface, kernel donor)
