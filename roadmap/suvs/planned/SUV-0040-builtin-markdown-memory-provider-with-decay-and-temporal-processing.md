---
id: SUV-0040
title: Built-in markdown memory provider with decay and temporal processing
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-28
updated: 2026-08-28
related:
  - ADR-0031 (the seam decision that carves this bounded default provider out of PLAN-040's non-goal)
  - ADR-0027 (the file-first alignment this provider restores literally at the storage layer)
  - SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md (ships the seam and the minimal builtin-markdown this SUV grows)
  - PLAN-025-artifact-plane-v1.md (the frontmatter-as-index precedent this provider's query surface follows)
blocked-by:
  - SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md (the seam and the minimal provider must exist before this build-out has anything to grow)
---

# SUV-0040 — Built-in markdown memory provider with decay and temporal processing

## Goal

Grow the minimal `builtin-markdown` provider SUV-0029 ships into a full-featured
default — decay and temporal processing, frontmatter-driven metadata, and the
gated-memory semantics proven by the private agentic-memory engine — while
staying the zero-prerequisite path: **no Python, no model download, no provider
key, no egress, ever**. On the non-goal boundary: PLAN-040's "no memory library
of ours" non-goal is carved by [ADR-0031](../../decisions/0031-vendor-neutral-memory-provider-seam.md)
for exactly this bounded default — a provider implementation behind the seam,
not a memory platform; see the ADR for the argument rather than re-arguing it
here.

## Scope

- **Storage is markdown files with frontmatter metadata** — tags, importance,
  timestamps, supersession/archive markers. This restores ADR-0027's file-first
  alignment *literally at the storage layer* for the default provider; ADR-0029
  had relocated that alignment to the interface because Headroom's substrate is
  SQLite. Here the substrate itself is the plain file.
- **Retrieval is lexical**: frontmatter + tags + full-text, weighted by recency,
  decay, and importance. There is no semantic search without embeddings — this
  is deliberate, the cost of zero provisioning burden, and it appears in
  Acceptance as a known, accepted property. The escape hatch is the seam
  itself: users who want semantic search pick the `headroom-mcp` provider.
- **Semantics modelled on the agentic-memory engine's proven behaviours**, as
  *provider behaviours behind the seam*, not a parallel engine: gated loads
  (memory enters context only at defined lifecycle points), logged retrieval
  (every read recorded), PRG-style trims, and archive markers — memories age
  out by decay into an archived state rather than being silently deleted.
- **Frontmatter as the query surface**, following PLAN-025's artifact-plane
  precedent: the shipped artifact plane already parses markdown frontmatter
  into its index, so structured metadata is available without inventing a new
  schema.
- **`describe()` reports capabilities honestly**: lexical search; full scoping
  support — unlike headroom-mcp's C2 collapse to the USER layer, this provider
  can honour `scope` natively; structured reads, unlike C3's prose strings; and
  no provisioning states — it is never "unprovisioned", which is the point of
  it as the default (ADR-0029's C1 does not apply to it).
- **Deliberately out:** embeddings or any vector index (that is what
  `headroom-mcp` is for, and building one is PLAN-040's Vector-DB non-goal);
  exposing memory tools to the model (host-invoked only, per ADR-0029/0031);
  any new query DSL beyond frontmatter + text.

## Acceptance

- [ ] The provider is registered behind the `MemoryProvider` seam and selectable by config, with no call-site changes — sessions and workflows call `search`/`save`/`describe` identically whichever provider is configured.
- [ ] A memory saved in one session is retrieved in a later session, asserted by an integration test against real markdown files on disk — frontmatter (tags, importance, timestamps) readable both by the test and by eye.
- [ ] Decay/temporal weighting demonstrably affects ranking: by test, a fresher or higher-importance memory outranks a stale, lower-importance one matching the same query terms.
- [ ] Retrieval logging and archive markers are observable on disk: every read is recorded, and a decayed-out memory carries an archive marker rather than being deleted.
- [ ] `describe()` accurately reports the provider's capabilities: lexical search (with the limitation stated), native scope support, structured reads, and no provisioning states.
- [ ] No egress at any point in this provider's lifecycle: no Python, no model fetch, no provider key, no network access — asserted by test, not just by review.
- [ ] The lexical-not-semantic limitation is recorded as an accepted property of the default, with `headroom-mcp` named as the semantic-search alternative.

## Status log

- `2026-08-28` — created in `planned/`, cut by the ADR-0031 re-cut alongside
  SUV-0029's re-scope; blocked on SUV-0029 shipping the seam.
