---
id: PLAN-025
title: Artifact plane v1 — registry, context-aware index, relations, Artifact Home (C1)
status: in-progress
direction: DIR-04
owner: jh
created: 2026-07-21
updated: 2026-07-21
related:
  - PLAN-024-review-workbench-dynamic-workspace-v1.md
blocked-by: []
---

# PLAN-025 — Artifact plane v1: registry, context-aware index, relations, Artifact Home (C1)

## Goal

Every artifact the workspace produces is browsable, typed, versioned, and related — with zero manual acquisition — behind `vorno:artifacts:*` channels and a minimal Artifact Home surface; v0.13.0 candidate.

## Scope

- **Generalize the PLAN-024 kernel** (in place, on main, post-#104-merge): parameterize the `reviews/` path literal by workbench/store type; open the closed artifact-kind enum into a type registry; drop the `.md`-only scan policy. `ArtifactVersion`, `resolveContainedArtifact`, hashing, and the plain-JSON store discipline carry forward as-is.
- **`vorno:artifacts:*` channel family** (additive per ADR-0012): index/query, read, relations, lifecycle (pin/promote/archive). Recorded in `compatibility.md` vorno-surface section.
- **Zero-config, context-aware index** (ADR-0015 §2): automatic scan of session `plans/` + `data/` across the workspace joined with `SessionHeader` context (projectId, labels, status); workspace-level corpus roots (e.g. `roadmap/`) configured once as an advanced setting, never per-instance.
- **Typed relations**: generalize `sessionLinks` into edges (`derived-from`, `references`, `renders`, `discussed-in`) on a relations file per artifact or store-side index.
- **Frontmatter as artifact metadata**: parse frontmatter into the index (title, tags, ids); existing conventions (roadmap docs, skills, Obsidian properties) become queryable for free.
- **JSON Canvas v1.0 as a first-class artifact type**: parse + basic render (read-only v1) + emit.
- **Obsidian file-native projection**: export/publish an artifact set as a vault-compatible folder (frontmatter + `.canvas`), the portability proof (~2 days inside the phase).
- **Artifact Home**: minimal renderer rail/page — list, filter (type/project/label/status/recency), open, relate. Deliberately *not* a workbench; picker-driven, auto-saving interactions per ADR-0015 §7.
- **Door ADR before code**: artifact URI scheme + type-registry model (owner sign-off required — one-way door).

## Non-goals

- Composed or interactive surfaces (C2/C3 — PLAN-026/027).
- Persistent full-text search index (filesystem scan + frontmatter join first; index when scale demands).
- Editing JSON Canvas (render/emit only in v1).
- Migration of PLAN-024 review threads beyond what the rename requires.

## Approach

Refactor-first: the workbench store/types/channels/handlers become the artifact plane's first implementation; the review workbench becomes a consumer of the generalized layer. New surface work limited to Artifact Home. Detailed technical sketch lands when this plan advances to in-progress (post door-ADR).

## Acceptance

- [ ] Open Vorno in a workspace with prior sessions → Artifact Home lists their plans/data artifacts with project/label/status context, zero configuration
- [ ] `vorno:artifacts:*` channels serve index/read/relations/lifecycle; recorded in compatibility.md
- [ ] A `.canvas` file renders read-only; an emitted artifact set opens cleanly as an Obsidian vault folder
- [ ] Review workbench still functions on the generalized store (no data loss)
- [ ] Door ADR (URI scheme + type model) accepted by owner before implementation
- [ ] Tests added/updated; CI-parity gates green
- [ ] Behind feature flag
- [ ] Roadmap docs updated

## Status log

- `2026-07-21` — created in `planned/` (ADR-0015 ratified the two-plane ladder; this is C1)
- `2026-07-21` — moved from planned to in-progress: PR #104 merged (`595a3bda`) unblocked the kernel; door ADR-0016 (URI scheme + open type registry) drafted as `proposed` on branch `plan-025-artifact-plane` — implementation gated on owner sign-off (G2a); detailed technical sketch lands post-sign-off
