---
id: PLAN-024
title: Review Workbench — first dynamic workspace surface (v0.13.0)
status: in-progress
direction: DIR-01
owner: jh
created: 2026-07-19
updated: 2026-07-19
related:
  - PLAN-023-hosted-workspace-server.md
blocked-by: []
---

# PLAN-024 — Review Workbench — first dynamic workspace surface (v0.13.0)

## Goal

Ship an in-app, interactive review workbench — the first of Vorno's dynamic workspaces for working with larger volumes of data — that lets Jeff (and future workspace teams) read dense architecture/governance artifacts with native diagrams, comment inline on specific text, aggregate artifacts across sessions and the roadmap corpus, and run an anchored question/feedback loop with agent sessions. Target release: **v0.13.0** (Jeff cuts).

## Scope

- **Shared types** (`packages/core`): `ArtifactRef`, `ReviewThread`, `WorkbenchInstance`, artifact-version anchoring (`contentHash` + optional `gitSha`), reusing `AnnotationV1` for anchors/bodies.
- **Workspace review store** (`packages/shared`): plain-JSON files under `{workspaceRoot}/reviews/<workbenchId>/` — one file per thread, agent-minable by construction (Read/Grep), with session back-links (`sessionLinks`) so reviews surface back into sessions and agentic mining.
- **Artifact index** (`packages/shared`): on-demand scan of (a) session `plans/` + `data/` markdown across the workspace, (b) per-workbench configured corpus roots (e.g. `roadmap/`). No persistent index in v0.1.
- **`vorno:workbench:*` RPC channels** (`packages/server-core` handlers + transport registration): `vorno:workbench:review:index`, `:artifact:read`, `:instances:list|create|update`, `:threads:list|mutate`. Additive per ADR-0012/ADR-0014; instance ids ride payloads, not channel names.
- **Renderer page** (`apps/electron`, feature-flagged): workbench list + artifact browser rail, document view (`Markdown` renderer → native mermaid/tables/diffs) wrapped in `AnnotatableMarkdownDocument` for select-to-comment, thread/decision rail (open questions, one-way-door decisions, filters), stale-artifact badge when `contentHash` no longer matches.
- **Question loop**: route an annotation as a question into a chosen session via existing `sessions:sendMessage`, embedding artifact path, quoted anchor, and thread id; replies are linked back on the thread (`sessionLinks`).
- WebUI inherits the page automatically (shared renderer).
- Compatibility audit: record the `vorno:workbench:*` surface in `roadmap/upstream/compatibility.md`'s vorno-surface section.

## Non-goals

- Canvas/tldraw projection (DIR-01's spatial act comes later and consumes this plan's store + index).
- Push-notification of thread changes to other live clients (refetch-on-focus in v0.1; add `vorno:workbench:review:changed` push when multi-client editing demands it).
- Interactive corpus graph (generated mermaid only, v0.2).
- Promotion tooling (comment → ADR edit stays an explicit agent/human act).
- An MCP tool for reviews (the store is plain files agents already Read/Grep; a dedicated tool waits for demand).
- Cutting the release — the PR is the 0.13.0 candidate; Jeff cuts per release policy.

## Approach

```mermaid
graph LR
  subgraph Renderer["Renderer page (desktop + WebUI)"]
    B["Artifact browser"] --> DV["Document view<br/>AnnotatableMarkdownDocument"]
    DV --> TR["Thread / decision rail"]
  end
  subgraph RPC["vorno:workbench:review:* (additive)"]
    IX["index / artifact:read"]
    TH["instances / threads CRUD"]
  end
  subgraph Store["Workspace store (agent-minable)"]
    RS[("reviews/&lt;workbenchId&gt;/<br/>workbench.json + threads/*.json")]
    SS[("sessions/&lt;id&gt;/plans+data<br/>+ corpus roots (roadmap/)")]
  end
  B --> IX --> SS
  DV & TR --> TH --> RS
  TR -- "question via sessions:sendMessage" --> AG["Agent session"]
  AG -- "reads/updates thread files" --> RS
```

Anchoring (ADR-0014): quote-anchored `AnnotationV1` targets + artifact `contentHash` (and `gitSha` for repo files). Stale versions badge, never silently re-anchor.

## Acceptance

- [ ] Open the PLAN-023 ALIGN artifacts (session 260719-noble-panther) in the workbench; mermaid diagrams and tables render natively
- [ ] Select text → add comment → thread persists under `{workspaceRoot}/reviews/` as plain JSON with content-hash anchor
- [ ] Ask a question from an annotation → message lands in a chosen session with artifact path + quote + thread id
- [ ] Stale-artifact badge appears when the underlying file changes
- [ ] An agent can locate and read review threads with Read/Grep alone (no new tools)
- [ ] Tests added/updated (store round-trip, index scan, anchor staleness)
- [ ] Behind feature flag
- [ ] `compatibility.md` vorno-surface entry; ADR-0014 recorded

## Status log

- `2026-07-19` — created in `planned/`
- `2026-07-19` — moved to `in-progress/`: build underway on branch plan-024-review-workbench
