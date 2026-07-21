---
id: ADR-0015
title: Two-plane architecture — artifact plane + surface plane, coupled by "a surface is an artifact"
status: accepted
date: 2026-07-21
supersedes: []
superseded-by: []
---

# ADR-0015 — Two-plane architecture: artifact plane + surface plane, coupled by "a surface is an artifact"

## Context

The Review Workbench (PLAN-024, ADR-0014) shipped end-to-end and passed CI, but runtime QA (2026-07-20/21) surfaced a scoping miss: it was a hand-built, single-purpose surface over a manually-configured artifact slice. The owner's restated target is broader: (1) holistic artifact management/organization/interaction, (2) multiple interface types and dynamically-generated UI surfaces (in-Vorno first, external surfaces as first-class integrations where built), (3) generative-UI approaches aligned with Vorno's architecture.

Discovery (session 260721-fleet-spring; full options analysis in that session's `plans/artifact-surfaces-direction-options.md`) established:

- The workbench branch isolated a reusable artifact kernel (`ArtifactVersion` content-hash/gitSha versioning, containment resolver, plain-JSON store with additive `schemaVersion` discipline, `WorkbenchType` discriminator, generalized `vorno:workbench:<type>:*` namespace). Review-specificity is concentrated and renameable.
- **MCP Apps (SEP-1865) is now a ratified Stable spec** (dated 2026-01-26): agent-delivered UI as `text/html;profile=mcp-app` in sandboxed iframes with metadata-derived CSP, interaction via JSON-RPC over postMessage with a small fixed `ui/*` method set. Hosts shipping: Claude, ChatGPT, Goose, VS Code, Copilot Studio.
- The industry converged on **"model emits typed data, trusted host renders"** (Vercel's retreat from `streamUI`; practitioner consensus of "generative techniques selectively within stable foundations"). Vorno's fenced blocks (datatable/mermaid/spreadsheet/html-preview) already are micro-scale schema-driven generative UI; the gaps are composition, persistence, and round-trip.
- Main lacks three dynamic-surface prerequisites: a page/renderer registry, an interactive sandbox (html-preview has no `allow-scripts`, no postMessage bridge), and outbound eventing.
- Open file-native specs exist to adopt rather than invent: **JSON Canvas v1.0** (jsoncanvas.org) and frontmatter-as-metadata conventions make artifacts first-class in Obsidian and similar tools with zero plugin code.

## Decision

**Vorno adopts a two-plane architecture, built as a ladder (Option C of the options analysis), with the coupling contract that a surface is itself an artifact** — typed, versioned, related to the data it renders. Sub-decisions, all owner-ratified 2026-07-21:

1. **Artifact plane first, thin (C1 / PLAN-025).** Generalize the PLAN-024 kernel into a workspace artifact layer: `vorno:artifacts:*` channels, open artifact-type registry (replacing the closed review enum), typed relations (generalizing `sessionLinks`), lifecycle verbs, and a minimal Artifact Home surface.
2. **Artifact acquisition is zero-config and context-aware.** The QA-identified failure was *manual* acquisition (per-instance corpus roots, pinning). The index is populated automatically from what the workspace produces and is aware of session/project/label/status context. Skills and workflow conventions may drive curation; manual root configuration is demoted to an advanced override. *(Owner ruling, Q1/Q2.)*
3. **Surface classes ship reliability-first: composed before expressive.** C2 (PLAN-026) delivers composed surfaces — a versioned declarative spec assembling the existing trusted block catalog into persistent pages — before C3 (PLAN-027) delivers interactive sandboxed-HTML surfaces. "Blandness > jank, always." The known catalog gaps to close over time: editable graph/diagram interfaces, editable datagrids, and smart chips (Docs/Office-style inline entity references). *(Owner ruling, Q3.)*
4. **The interactive-surface bridge adopts the ratified MCP Apps contract rather than a bespoke one.** C3's iframe class and postMessage bridge align method names and semantics with SEP-1865's `ui/*` set. This is both the cheapest correct substrate and a deliberate signal of Vorno's portability/interoperability/standards commitment. *(Owner ruling.)*
5. **Open file-native specs are adopted at the code level.** JSON Canvas v1.0 becomes a first-class Vorno artifact format (read/render/emit); frontmatter is the artifact-metadata convention, keeping artifacts portable and letting existing/emerging frontmatter ecosystems (Obsidian properties, agentskills.io) apply to Vorno artifacts natively. *(Owner ruling.)*
6. **External surfaces are first-class integrations or not built.** Where Vorno projects into external tools (Obsidian, Chrome, Notion, other SaaS), the integration should be a first-class interactive client over the target's MCP/API/SDK — not fire-and-forget publishing — or deferred. The file-native Obsidian projection qualifies (the vault *is* the interface). *(Owner ruling, Q4.)*
7. **Interaction-quality is a design principle, not polish.** Workbench QA surfaced friction (paste-then-save folder entry, no session/label/project pickers, non-responsive updates). Dynamic surfaces are built to *avoid* this class: auto-save, responsive state, picker/selector affordances over free-text config. Logic layers are the keepers; friction is a defect.
8. **Working vocabulary (orientation, deliberately non-binding):** a *Workflow* is a process that moves material; a *Workbench* is where a workflow happens (one surface type among several); a *Workspace* is the collection of workbenches material moves through. Recorded to align naming as surfaces multiply — explicitly not a commitment to a single "workflow" framing. *(Owner note.)*
9. **PLAN-024 / PR #104 disposition:** merge as-is (additive, feature-flagged dark) after a dedicated code-quality review session, decoupled from v0.13.0. The review workbench becomes one workbench type among several; v0.13.0 targets C1 instead.

## Consequences

### Positive

- Bullets 1–3 of the owner's target become one architecture instead of two projects; every phase ships a consumer for the previous phase's layer.
- The PLAN-024 kernel is salvaged in place (renames on main) instead of rewritten; `vorno:workbench:review:*` remains a valid additive wire family per ADR-0012.
- Standards alignment (MCP Apps `ui/*`, JSON Canvas, frontmatter) minimizes invented contracts and opens the later door to Vorno acting as a full MCP Apps host.

### Negative

- ~5–6 focused weeks across three phases before both planes exist at v1; C1 must stay ruthlessly thin to avoid the workbench's fate.
- `allow-scripts` sandboxing (C3) is a real new trust boundary requiring its own security review before code.
- The composed-surface spec (C2) is a new versioned format we own forever (additive-only evolution per the ADR-0013 discipline).

### Neutral

- DIR-01 (canvas) becomes a *projection* of the artifact plane (JSON Canvas artifacts prefigure it); DIR-02 (skill contributions) targets the surface spec and type registry, deferred to C4; DIR-03 (observatory) eventually consumes surfaces. New DIR-04 carries the two-plane frame.
- Side-quests noted, not scheduled: participation in schema-driven UI standardization (A2UI et al.) from a shipping-product perspective; a deep-research pass on portable artifact+skill bundle standards is in flight and may produce a future ADR.

## Alternatives considered

- **Artifact-plane-only first (Option A)** — rejected: its v1 consumer would be another hand-built static page, the shape that just failed QA.
- **Surface-runtime-first (Option B)** — rejected: generated surfaces without an artifact plane reproduce today's sprawl; the owner's first-stated need is organization.
- **Skills-manifest/contribution-registry-first (Option D)** — rejected for now: hardest infrastructure of the four with no artifact plane or surface spec to register; also potentially duplicative with contribution surfaces in downstream harnesses (Claude, Codex, Pi). Folded into C4.
- **Canvas-first** — re-rejected (see young-willow options analysis + this session's landscape research): a workspace paradigm, not a widget mechanism; Figma/ComfyUI interaction *patterns* remain reusable references for later surface types.

## References

- Options analysis: session 260721-fleet-spring `plans/artifact-surfaces-direction-options.md` (discovery evidence, effort estimates, PR #104 reasoning).
- ADR-0012 (`vorno:*` additive namespace), ADR-0013 (workspace AuthZ grain, additive-format discipline), ADR-0014 (workbench store/anchors — kernel being generalized).
- MCP Apps SEP-1865 spec 2026-01-26 (modelcontextprotocol/ext-apps); JSON Canvas v1.0 (jsoncanvas.org); kepano/obsidian-skills (file-native agent-integration pattern).
- DIR-04 (direction statement), PLAN-025/026/027 (phase plans).
