---
id: SUV-0030
title: Memory extension interface designed and proposed upstream
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md (the interface extends the memory substrate in actual use)
---

# SUV-0030 — Memory extension interface designed and proposed upstream

## Goal

Design the pluggable extension interface for additional memory storage formats
and querying against Headroom's existing seams, and open it as an upstream
contribution.

## Scope

- An interface specification (storage-adapter / hook contract for alternative
  storage formats and query semantics) designed against Headroom's extension
  seams — pipeline hooks, compression hooks, provider slices — committed as a
  design doc in `roadmap/`, with query semantics that treat markdown
  frontmatter as already-structured data.
- The upstream contribution: an issue or PR opened on the Headroom repo
  proposing the interface. If upstream declines, the decline and the
  carry-a-patch rationale are documented instead — either outcome closes this
  SUV.
- Deliberately out: any backend implementation (SUV-0031 is the first
  consumer) and forking Headroom (plan non-goal — seams and upstream PRs
  only).

## Acceptance

- [x] A design doc in `roadmap/` specifies the extension interface — operations, storage-format contract, query semantics — and names the specific Headroom seams it builds on.
- [x] The design demonstrates (on paper) that the agentic-memory v2 engine's gated behaviors can express as a backend behind it, or records exactly which behaviors need upstream interface support.
- [x] An upstream issue or PR proposing the interface is open on the Headroom repo and linked from the design doc — or upstream's decline is documented with the maintained-patch rationale.
- [x] The design doc records what shape upstream maintainers indicated they would accept (plan open question 2), even if the answer is "no response yet" with a dated follow-up plan.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — **delivered.** Design doc: [`roadmap/evidence/PLAN-040/memory-extension-interface-design.md`](../../evidence/PLAN-040/memory-extension-interface-design.md).
  Upstream contribution: [headroomlabs-ai/headroom#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) (filed 2026-08-27, open, no response yet).

  **The premise inverted in the favourable direction: most of the interface already exists upstream.**
  `headroom/memory/ports.py` defines `MemoryStore` / `VectorIndex` / `TextIndex` /
  `Embedder` / `MemoryCache` / `GraphStore` Protocols; `config.py` carries an
  `EXTERNAL` member on all three storage backend enums; `factory.py` loads
  third-party implementations from `entry_points` under `headroom.memory_store` /
  `headroom.memory_vector` / `headroom.memory_text`. So the contribution is not a
  new interface but **four additive gaps** that stand between that seam and a
  *governed* backend: (A) a `RetrievalContext` threaded to the backend so
  destination-dependent gating is possible at all; (B) a withheld/refused result
  envelope so "3 items withheld" and "refused" stop reading as "no results";
  (C) annotations that survive compression, for the mandatory cold-storage marker;
  (D) a TypeScript path or an explicit statement that memory is Python/CLI-only.
  Plus (E): the seam is entirely undocumented — `wiki/memory.md` is 753 lines and
  never mentions it. E is offered as a PR unconditionally.

  **Frontmatter maps with no upstream schema change:** `subjects` → `entity_refs`
  (already an any-of filter), `scope` / `visibility` / `archived` →
  `metadata_filters`, write-side scope inheritance → `promoted_from` +
  `promotion_chain`. The salvage note's *conclusion* (treat frontmatter as
  structured data) survives; its *justification* ("Headroom's substrate is local
  markdown") does not, and is struck in §4 of the doc.

  **v2 gated behaviors, all eleven addressed:** 4 expressible today (scope trim,
  subject trim, write-side inheritance, and the substantive half of no-pollution),
  5 blocked on gap A, 1 on C, 1 on A+B, 1 (citation discipline) outside the
  backend's remit. §3.1 states the limit plainly: PRG is a post-retrieval,
  pre-use check and a storage backend is a query-time seam, so even with A–C
  granted this interface mechanizes only trims 1–3 + archive + logging — the same
  set the v2 server mechanizes today. SUV-0031 should not attempt more, and we
  should not ask upstream to own Vorno's policy layer.

  **Two corrections owed to PLAN-040**, recorded in doc §4: the salvage note's
  markdown-substrate justification (above), and the seam list — `on_pipeline_event`
  **does not exist** in the pinned TypeScript SDK (only `pipelineTiming`, a stats
  field), and "downstream MCP tools" is not a seam of that package. Of the four
  seams the plan names, exactly one — compression hooks — is a real extension
  point in `headroom-ai@0.36.5`.

  **Upstream bug found and reported in the issue:** `CompressionHooks.computeBiases`
  is documented in the SDK README and wiki but its return value reaches nothing.
  Verified in the pinned bundle *and* against `sdk/typescript/src/compress.ts` on
  `main`, where `biases` is assigned and never read — `client.compress()` receives
  only `{ model, tokenBudget }`. It is the natural mechanism for gap C; if biases
  were forwarded, C would need no new API.

  **`blocked-by: SUV-0029` did not in fact block this SUV** and the edge is left in
  place for the owner to clear: the deliverable is an artifact *about* Headroom's
  interface plus an outreach act, neither of which needs a Vorno-reachable memory
  API. The audit's own recommendation (its option 4, "contribute memory to the TS
  SDK upstream") is gap D of the filed issue — so this SUV advances SUV-0029's
  unblocking rather than waiting on it.

  Doc-only SUV: no product code changed. A tripwire test for the two SDK findings
  was considered and deliberately not written (doc §8) — it would be an
  out-of-scope diff; SUV-0031 should carry it if it depends on those facts.
  Folder move and frontmatter `status` left to `[skill:roadmap-plan-advance]`, and
  the `blocked-by` edge to the owner.
