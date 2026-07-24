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

- [ ] Open Vorno in a workspace with prior sessions → Artifact Home lists their plans/data artifacts with project/label/status context, zero configuration *(runtime QA — Jeff)*
- [x] `vorno:artifacts:*` channels serve index/read/relations/lifecycle; recorded in compatibility.md
- [ ] A `.canvas` file renders read-only; an emitted artifact set opens cleanly as an Obsidian vault folder *(parse/emit/projection covered by tests; in-app render + Obsidian open = runtime QA)*
- [x] Review workbench still functions on the generalized store (no data loss — `reviews/` store and frozen wire family untouched; 19-test workbench suite green; A3/A4 advisory fixes applied)
- [x] Door ADR (URI scheme + type model) accepted by owner before implementation (ADR-0016 signed 2026-07-22, PR #106 review)
- [x] Tests added/updated (78 artifact-module tests); CI-parity gates green (7 typechecks, shared 3246/0, server 190/0, doc-tools, i18n ×3, branding, build; electron tsc at 108 baseline)
- [x] Behind feature flag (`artifactsEnabled`, default off)
- [x] Roadmap docs updated

## Status log

- `2026-07-21` — created in `planned/` (ADR-0015 ratified the two-plane ladder; this is C1)
- `2026-07-21` — moved from planned to in-progress: PR #104 merged (`595a3bda`) unblocked the kernel; door ADR-0016 (URI scheme + open type registry) drafted as `proposed` on branch `plan-025-artifact-plane` — implementation gated on owner sign-off (G2a); detailed technical sketch lands post-sign-off
- `2026-07-22` — **G2a closed**: owner signed all four doors (PR #106 review) with three inline amendments (storage-separation stated goal on root bindings; namespace reservation — un-prefixed ids reserved for system; read serves an *artifact*, not a file). ADR-0016 → `accepted` with amendments folded in. C1 build proceeding on `plan-025-artifact-plane`.
- `2026-07-22` — **C1 built end-to-end** (three legs): (1) shared module `@craft-agent/shared/artifacts` — URI parse/format, root bindings + realpath containment, open type registry (markdown/json-canvas/json/file), zero-config index with frontmatter + SessionHeader context join, relations + lifecycle stores, read gate, JSON Canvas parse/emit, Obsidian vault projection, 78 tests; (2) `vorno:artifacts:*` wire surface (7 channels, REMOTE_ELIGIBLE) + server-authoritative handlers + `artifactsEnabled`/`artifactRoots` workspace settings; (3) renderer — Artifact Home page (filter rail / list / detail + relations w/ unresolvable-badge), read-only JSON Canvas view, settings toggle + roots editor (directory-picker), 57 i18n keys ×7 locales, workbench advisory fixes A3 (annotation-drop toast) + A4 (corpus-roots draft clobber). CI-parity gates all green. Remaining: Jeff runtime QA (G2c) + Obsidian-open spot check.
