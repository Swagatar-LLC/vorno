---
id: PLAN-040
title: Context discipline — adopt Headroom (supply chain) + extract our token/memory library
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

# PLAN-040 — Context discipline: adopt Headroom, extract our token/memory library

> **Two workstreams, one piece of the DIR-05 milestone.** The context-compression
> layer is **not built here — it is adopted**:
> [Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0, Rust core
> with TypeScript/Python SDKs, CLI + local proxy + MCP server) enters Vorno's
> supply chain as the compression/trimming engine. What we **extract and open-source
> ourselves** is the complement Headroom does not provide: token/budget
> *accounting and policy*, and a *gated durable memory engine*. Our library needs
> its own name (product-owner call; "Headroom" refers to the adopted upstream,
> not to us).

## Goal

Long-running and repeated agent work (PLAN-039 workflows especially) gets
disciplined context behavior from a layered stack: **Headroom** compresses what
enters and leaves the context window; **our library** (working name TBD) decides
*when and what* — budgets, thresholds, trim policy, and durable memory — and is
published as a harness-agnostic OSS library that Vorno itself consumes.

## Division of labor (the load-bearing table)

| Concern | Home | Rationale |
|---|---|---|
| Tool-output / JSON / code / prose compression | **Headroom (adopted)** | Mature (~67k stars), content-aware, reversible (originals retrievable) — do not rebuild |
| Reversible-compression cache & retrieval | **Headroom (adopted)** | Comes with the engine |
| Token/context **accounting** (per session/step, observed-total semantics) | **Ours** | Headroom compresses; it does not budget. Conductor semantics (no double-counting across turns) are ours |
| **Thresholds, budget ceilings, policy** (warn/act *before* the ceiling) | **Ours** | Policy layer that *invokes* compression as one strategy among several |
| Gated durable **memory** (explicit loads, logged retrieval, decay/archive with "was true at one time" markers) | **Ours** | Generalized from the private agentic-memory v2 engine; philosophically different from cache-style shared context |
| Cross-agent shared context | **Evaluate Headroom's first** | It ships one; build ours only if its semantics don't fit the gated model |

## Scope

### H0 — Headroom adoption (supply-chain workstream)

- **Integration-surface decision:** TS SDK (in-process) vs. local proxy vs. MCP
  server. Bias: the narrowest surface that fits the agent loop; record as an ADR
  if the choice constrains architecture.
- **Supply-chain vetting before first integration** — this component sits in the
  token path and sees *all* context: license audit (Apache-2.0 ✓, verify
  NOTICE obligations), network/telemetry behavior audit (nothing leaves the
  machine without explicit opt-in), version pinning (no `latest` dist-tags —
  LEARNING-062 class), and a documented update cadence.
- **Verify claims on our workloads:** benchmark compression ratios and answer
  accuracy on real Vorno sessions (tool-heavy, JSON-heavy) before enabling
  anywhere by default.
- **Policy-gated and reversible:** compression is a strategy our policy layer
  invokes — per-workspace flag, off by default until benchmarks pass, always
  disable-able. Vorno must run correctly with Headroom absent.

### H1 — Token headroom accounting + policy (our library)

- Context-window usage tracking per session/step; input/output deltas;
  cumulative budgets with the Conductor's observed-total semantics.
- Thresholds (warn/act), budget ceilings, pluggable trim strategies — of which
  **Headroom compression is the flagship strategy**, alongside summarize/evict.
- Telemetry event stream a host can subscribe to (the shape Vorno's token-usage
  UI consumes today; PLAN-002/003 surfaces migrate onto it).

### H2 — Memory (our library)

- Gated read/write memory engine generalized from the private `agentic-memory`
  v2 engine: explicit context loads, query-based retrieval with retrieval
  logging, trim/decay policies, archive semantics with mandatory
  "was true at one time" markers.
- File-based, human-readable reference storage adapter (markdown + JSON/JSONL);
  storage adapter seam so SQLite is an adapter, not a rewrite. No heavy runtime
  dependency in the core.
- **Precondition:** evaluate Headroom's cross-agent memory/shared-context
  feature first; H2 proceeds where the gated model (logging, decay, archive
  markers) exceeds what it offers.

### Integration (in-repo, same milestone)

- Vorno consumes H1 for workflow runs (PLAN-039 W1+); existing token UI reads
  through it.
- The `agentic-memory` MCP source becomes a thin host over H2.
- Headroom wired as a trim strategy behind the policy flag (H0 gates).

## Non-goals

- **Building compression.** That is Headroom's job; forking or reimplementing it
  is explicitly out.
- **Not a vector database, not RAG infrastructure.** Retrieval is explicit and
  logged; embedding adapters are a later contribution.
- **Not a hosted service.** Library + adapters only.
- **No Vorno wire-protocol coupling** — usable from a bare agent-SDK loop, per
  the harness-agnosticism charter.

## Open questions (resolve at design review)

1. **Our library's name** + npm scope; repo home (`Swagatar-LLC/<name>`, public
   from day one — no-personal-names and no-account-identifiers rules apply from
   the first commit). Must not collide with or trade on "Headroom".
2. Headroom integration surface (SDK / proxy / MCP) — and whether Vorno's
   existing MCP source machinery makes the MCP server the cheapest first step
   even if the SDK is the end state.
3. One package or two for H1/H2? Bias: one repo, two entry points.
4. License for our library (Apache-2.0, matching both the fork's posture and the
   adopted upstream).
5. How much of the v2 memory engine's PRG-trim behavior is general vs. personal
   policy — the engine/adapter split line.

## Acceptance

- [ ] H0: written vetting report (license, telemetry/network audit, pinning policy) + benchmark results on real Vorno workloads, committed to `roadmap/evidence/`.
- [ ] H0: Headroom integrated behind a per-workspace policy flag, off by default; Vorno fully functional with it absent or disabled.
- [ ] H1: a workflow run reports headroom through our library; thresholds fire a policy callback before the ceiling; compression invoked only via policy.
- [ ] H2: engine passes a conformance suite over the reference file adapter; retrieval operations are logged; Headroom shared-context evaluation written up before H2 build starts.
- [ ] Public repo (our library) with CI, README, and a runnable example against a bare agent loop (no Vorno import); Vorno consumes it with no forked copies of the logic in-app.
- [ ] No personal names, personal data, or infrastructure account identifiers in the public repo (charter hard rules).
- [ ] Docs: a `vorno.ai/docs` page positioning the stack — Headroom (adopted) + our library — and their relationship to Vorno.

## Status log

- `2026-08-22` — created in `planned/` as the second half of the DIR-05 milestone (top roadmap priority).
- `2026-08-22` — **reframed on product-owner correction:** Headroom (headroomlabs-ai/headroom) was always intended as an *adopted supply-chain component*, not a library we author under that name. Plan restructured into H0 adoption + H1/H2 complementary library (name TBD); file renamed accordingly.
