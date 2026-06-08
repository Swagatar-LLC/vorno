---
id: DIR-02
title: Skills as Contribution Points
status: active
opened: 2026-04-28
related-discussions:
  - 2026-04-28-canvas-paradigm-directions.md
related-plans: []
---

# Direction 2 — Skills as Contribution Points

> *"VS Code's contribution model, rethought around AI-native modalities."*

## Thesis

A Craft skill today is a `SKILL.md` file containing instructions. Useful, but limited: skills can't extend the *shell*, only inform the *agent*.

VS Code's extension model proves that a clean **contribution-point manifest** + **sandboxed UI surface** + **declarative activation events** unlocks a thriving third-party ecosystem. ComfyUI's `custom_nodes` shows the same lesson at a smaller scale: a community will build thousands of specialized nodes if the plugin API is clean and simple.

We extend Craft's `SKILL.md` frontmatter into a contribution manifest. A skill can ship:

- **Custom shape types** for the canvas (Direction 1)
- **Custom tools** the agent can call
- **Custom views** in the app shell
- **Custom render blocks** (extending html-preview/datatable/etc)

## Example manifest

```yaml
---
name: music-daw
contributes:
  shapes:
    - id: mixer
      kind: canvas
      module: ./shapes/mixer.tsx
    - id: track
      kind: canvas
      module: ./shapes/track.tsx
  tools:
    - id: render_mix
      module: ./tools/render-mix.ts
    - id: export_stems
      module: ./tools/export-stems.ts
  views:
    - id: timeline
      kind: panel
      module: ./views/timeline.tsx
---

# Music DAW Skill

Instructions for how the agent should work with this DAW...
```

The agent activates via the existing `[skill:music-daw]` reference. The renderer reads `contributes:` and registers shapes/tools/views with the appropriate registry.

## Architecture

- **`ContributionRegistry` in the renderer** — central map of contribution-id → loaded module.
- **Sandboxed loading** — borrow VS Code's webview pattern. Custom shapes/views render inside iframe-like containers with `postMessage` to the shell. Tools are easier — they run in the agent's existing sandboxed permission model.
- **Activation events** — `onShape:*`, `onTool:*`, `onView:*`. Lazy by default.
- **Capability scoping** — a skill declares what it accesses (filesystem, network, source X). Aligns with our existing permission policy model.
- **Manifest validation** — schema-check `contributes:` on load; reject malformed skills with a clear error.

## What this unlocks

1. **Modality ecosystem.** Third parties (or us) can ship a music DAW, a 3D scene viewer, a spreadsheet modality, a code editor — composable on the same canvas.
2. **No fork-the-shell tax.** New modalities don't require recompiling Craft.
3. **Shared agent across modalities.** The orchestrator already speaks all skills. A `[skill:music-daw]` + `[skill:3d-scene]` agent can wire mixer outputs into a 3D visualization without us anticipating that combination.

## v0.1 scope (future PLAN)

The smallest possible surface — *one* contribution point, prove the loop:

- Extend `SKILL.md` frontmatter with `contributes.shapes` only
- Build `ContributionRegistry` in renderer with shape registration only
- Ship one sample skill: `[skill:annotation-shape]` adding a custom annotation shape
- Document the manifest schema
- Defer: tools, views, sandboxing hardening, capability scoping

Once that loop works, expand to tools and views.

## Early seams

Ahead of the full `ContributionRegistry`, PLAN-007 ships a small precursor for the
`views` contribution point: an **item-renderer registry** for the orchestration
panel in `packages/ui/src/components/orchestration/registry.tsx`
(`registerOrchestrationItemRenderer(kind, component)` + a default renderer). When
the real registry lands, skill-contributed `views` should drive their renderer
registrations through this same API rather than a parallel mechanism.

## Constraints / non-goals

- v0.1 does **not** address sandboxing rigorously — sample skills will be trusted (ours).
- We borrow VS Code's *patterns*, not their *runtime*. Our contribution host is much smaller.
- We will not break existing skills' behavior — `contributes:` is purely additive.

## Open questions

- Module loading: dynamic `import()` of shipped TypeScript? Pre-bundled? Esbuild at install time?
- Sandboxing strategy for v1 — webview iframe vs Web Worker vs `vm` module.
- How do contribution skills install/update? In-app or via filesystem?
- Multi-skill conflicts: two skills register a `mixer` shape — namespace by skill ID?

## References

- [VS Code API: Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [Obsidian Plugin API](https://docs.obsidian.md) (looser model — instructive contrast)
- [ComfyUI custom_nodes](https://github.com/comfyanonymous/ComfyUI) — minimum-viable plugin API as the lesson
