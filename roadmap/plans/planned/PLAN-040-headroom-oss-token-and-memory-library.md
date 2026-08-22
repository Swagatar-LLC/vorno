---
id: PLAN-040
title: Headroom — an OSS token-headroom and memory library
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-002-token-usage-display.md (in-app precedent)
  - PLAN-003-token-usage-thresholds-workspace-settings.md (in-app precedent)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md (milestone sibling)
blocked-by: []
---

# PLAN-040 — Headroom: an OSS token-headroom and memory library

> **Naming note:** "Headroom" is the working title (the space left in a context
> window before the ceiling). Final name is a product-owner call before the
> repo is created.

## Goal

Extract Vorno's context-survival disciplines — token/headroom accounting,
budget thresholds and trim policies, and gated durable memory — into a
standalone, harness-agnostic **open-source TypeScript library** that Vorno
itself consumes, so long-running and repeated agent work (PLAN-039 workflows
especially) has disciplined context behavior, and other harnesses can adopt
the same discipline without adopting Vorno.

## Why (and why OSS)

- **Vorno needs it anyway.** Reusable workflows that run unattended are exactly
  the workload that exhausts context and needs memory across runs. Today the
  relevant logic is scattered: token usage/thresholds live in app surfaces
  (PLAN-002/003), per-run token budgets live in the Conductor, and memory
  gating (context loads, retrieval logging, trims) lives in a private MCP
  server over a personal data layer. None of it is importable.
- **The charter says harness-agnostic.** This is the first concrete artifact of
  that principle: a library with no Vorno dependency, consumed by Vorno.
- **Consuming our own library hardens it.** The extraction forces clean seams
  (storage adapters, harness adapters) that the in-app versions never needed.

## Scope

Two halves, one package (or a small workspace of two packages — decide at
design time):

### H1 — Token headroom

- **Accounting:** context-window usage tracking per session/step; input/output
  token deltas; cumulative budgets with the Conductor's observed-total
  semantics (a step that runs multiple turns can't double-count).
- **Policy:** thresholds (warn/act), budget ceilings, and pluggable trim/
  compaction strategies invoked *before* the ceiling, not after the failure.
- **Telemetry:** a small event stream a host can subscribe to (the same shape
  Vorno's token-usage UI consumes today).

### H2 — Memory

- **A gated read/write memory engine** generalized from the private
  `agentic-memory` v2 engine: explicit context loads, query-based retrieval
  with retrieval logging, trim/decay policies, and archive semantics
  ("was true at one time" retrieval markers).
- **File-based, human-readable substrate** (markdown + JSON/JSONL) as the
  reference storage adapter — portable, diff-able, git-versioned. The
  *engine* is extracted; the *personal data* obviously is not.
- **Storage adapter seam** so SQLite (or anything else) is an adapter, not a
  rewrite. No heavy runtime dependency in the core.

### Integration (in-repo, same milestone)

- Vorno consumes H1 for workflow runs (PLAN-039 W1+) and surfaces the existing
  token UI through it.
- The `agentic-memory` MCP source becomes a thin host over H2.

## Non-goals

- **Not a vector database, not RAG infrastructure.** Retrieval is explicit and
  logged, not embedding-similarity magic; an embedding adapter can be a later
  contribution.
- **Not a hosted service.** Library + adapters only.
- **No Vorno wire-protocol coupling** — the library must be usable from a bare
  Claude Agent SDK loop, per the harness-agnosticism charter.
- **Migration of existing personal memory data is out of scope** beyond
  demonstrating the reference adapter reads the existing layout.

## Open questions (resolve at design review)

1. Final name + npm scope; repo home (`Swagatar-LLC/<name>`, public from day
   one — which means the no-personal-names and no-account-identifiers rules
   apply from the first commit).
2. One package or two (`headroom-tokens` / `headroom-memory`)? Bias: one repo,
   two entry points.
3. License (upstream-compatible; likely Apache-2.0 to match the fork's posture).
4. How much of the v2 memory engine's PRG-trim behavior is general vs. personal
   policy — the split line between engine and adapter.

## Acceptance

- [ ] Public repo with CI, README, and a runnable example against a bare agent loop (no Vorno import).
- [ ] H1: a workflow run in Vorno reports headroom through the library; thresholds fire a policy callback before ceiling.
- [ ] H2: the engine passes a conformance suite over the reference file adapter; retrieval operations are logged.
- [ ] Vorno consumes the library from npm (or workspace link pre-publish) — no forked copies of the logic remain in-app.
- [ ] No personal names, personal data, or infrastructure account identifiers anywhere in the public repo (charter hard rules).
- [ ] Docs: a `vorno.ai/docs` page positioning the library and its relationship to Vorno.

## Status log

- `2026-08-22` — created in `planned/` as the second half of the DIR-05 milestone (top roadmap priority).
