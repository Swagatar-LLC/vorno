---
id: SUV-0040
title: Built-in markdown memory provider with decay and temporal processing
status: done
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
blocked-by: []
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

- [x] The provider is registered behind the `MemoryProvider` seam and selectable by config, with no call-site changes — sessions and workflows call `search`/`save`/`describe` identically whichever provider is configured.
- [x] A memory saved in one session is retrieved in a later session, asserted by an integration test against real markdown files on disk — frontmatter (tags, importance, timestamps) readable both by the test and by eye.
- [x] Decay/temporal weighting demonstrably affects ranking: by test, a fresher or higher-importance memory outranks a stale, lower-importance one matching the same query terms.
- [x] Retrieval logging and archive markers are observable on disk: every read is recorded, and a decayed-out memory carries an archive marker rather than being deleted.
- [x] `describe()` accurately reports the provider's capabilities: lexical search (with the limitation stated), native scope support, structured reads, and no provisioning states.
- [x] No egress at any point in this provider's lifecycle: no Python, no model fetch, no provider key, no network access — asserted by test, not just by review.
- [x] The lexical-not-semantic limitation is recorded as an accepted property of the default, with `headroom-mcp` named as the semantic-search alternative.

## Status log

- `2026-08-28` — created in `planned/`, cut by the ADR-0031 re-cut alongside
  SUV-0029's re-scope; blocked on SUV-0029 shipping the seam.
- `2026-08-28` — **EXECUTED. `planned/` → `done/`, all seven acceptance items
  met. Unblocked in the same pass that shipped SUV-0029**, so `blocked-by` is
  cleared rather than left pointing at a dependency that is now satisfied.

  Shipping the two together was a judgement call, and the reason is that the
  split was always about *scope legibility*, not sequencing: SUV-0029 needed a
  second real provider to prove the seam vendor-neutral, and a `builtin-markdown`
  stripped of decay would have been a provider written twice. The two SUVs kept
  their separate acceptance lists and are ticked independently — read this log
  for the depth, SUV-0029's for the seam.

  **What "modelled on the agentic-memory engine" turned into, concretely.** The
  engine's decay model reimplemented rather than imported (it is Python, in a
  private repo — the seam exists so we need its *behaviour*, not its code):
  exponential half-life `0.5 ** (age / halfLife)`; three bands at 0.5 / 0.25;
  importance modulating the **half-life** rather than the score, because
  doubling a half-life means decaying slower forever where adding to a score
  merely shifts when it crosses a band; and `salience: pinned` as a genuine
  exemption rather than a very long half-life. The anchor is
  `max(updated, lastCited)` — citation as reinforcement is the load-bearing
  idea of the source engine, and it is why `search()` writes back to the store.

  **The PRG, adapted honestly.** Scope trim runs *after* retrieval and before
  use, with the asymmetry that matters spelled out and tested: an unscoped
  memory is broad and travels; a scoped one is narrow and stays; and a target
  that **omits** a layer the memory declares is a mismatch, **not** a wildcard.
  Without that asymmetry a search that simply forgot to pass `session` would
  silently see every session's private memories.

  **Archive, not delete.** A decayed memory `git`-less-ly moves to
  `memory/archive/`, gains `archived:` / `archive-reason:` frontmatter and the
  mandatory cold-storage banner, and is excluded from searches by default —
  because an archive that still loads is not an archive, it is a rename. The
  banner travels into the prompt when cold storage is deliberately searched, so
  cold content is never restated as a current fact. The sweep runs on **save**,
  not on search: a save is already a write, and sweeping on every read would
  make retrieval latency scale with corpus size.

  **Two decisions worth defending.** (1) Ranking uses *floored* multiplicative
  terms (`RECENCY_FLOOR` 0.5, `IMPORTANCE_FLOOR` 0.6). Unfloored, a two-year-old
  memory scores ~0 however exactly it matches, and the ranking becomes a recency
  sort wearing a relevance costume. (2) A `MIN_LEXICAL_SCORE` floor of 0.2, so
  decay and importance can never promote an *irrelevant* memory into context:
  a memory system whose failure mode is confidently supplying the wrong context
  is worse than one that supplies none.

  **The file format is hand-parsed, deliberately**, despite `gray-matter` being
  a dependency two directories away. Two reasons: this module both reads and
  writes, and a full YAML parser paired with a hand-written serializer is two
  grammars that can drift; and the no-egress claim is cheaper to defend the
  fewer moving parts the provider has. Flatness is a compatibility contract, not
  a shortcut — flat scalars and arrays-of-scalars are exactly what the shipped
  artifact plane's frontmatter indexer projects (PLAN-025), so these files are
  queryable by that index without a parallel schema.

  **A real bug the round-trip test caught**, which review would not have: the
  parser stripped one leading newline where the serializer writes two, so the
  cold-storage banner was never line zero and the strip-on-read never fired.
  Every save of an archived memory would have prepended another banner — one
  per write, forever. Fixed, and pinned by a test that serializes twice and
  asserts the bytes are identical.

  **No egress, asserted rather than reviewed.** The acceptance item is met by
  scanning the provider's own source for `fetch`, `node:http(s)`, `node:net`,
  `child_process`, `spawn`, `XMLHttpRequest`, and any `process.env` read — a
  source-level assertion rather than a runtime one, because a runtime check only
  proves the path a test happened to take. `describe()` reports
  `egress: 'none'`, `requiresProvisioning: false`, and `state` that can never be
  `unprovisioned` — ADR-0029's C1 is structurally impossible here, which is the
  entire argument for this provider being the default.

  **The honest cost is in the product, not just the roadmap.** `describe().notes`
  names the lexical-not-semantic limitation in the provider's own words and
  points at `headroom-mcp` as the alternative; the settings section renders those
  notes rather than hiding them; and `docs/memory.md` gives a concrete paraphrase
  the provider would miss. A capability flag that flatters the provider is worse
  than no flag.

  Landed on `plan/plan-040`: `decay.ts`, `lexical.ts`, `memory-file.ts`,
  `markdown-store.ts`, `builtin-markdown-provider.ts`, and their tests
  (135 in `src/memory` total, of which the builtin provider's integration suite
  runs against real files in a real temp directory — no mocked filesystem,
  because "observable on disk" is not assertable against a fake one).
