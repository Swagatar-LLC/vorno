---
id: PLAN-040
title: Integrate Headroom — context compression, token management, and memory
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-26
related:
  - PLAN-002-token-usage-display.md (surface that migrates onto Headroom stats)
  - PLAN-003-token-usage-thresholds-workspace-settings.md (surface that migrates onto Headroom stats)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md (milestone sibling)
related-suvs:
  - SUV-0014-vet-and-pin-headroom-for-adoption.md (first — pins the SDK)
  - SUV-0015-headroom-boundary-module-with-noop-fallback.md (after 0014)
  - SUV-0016-headroom-config-schema-storage-and-precedence.md (independent of 0014/0015)
  - SUV-0017-workspace-settings-ui-for-headroom.md (after 0016)
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (needs 0015 and 0016)
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (I1 — after 0018)
  - SUV-0024-compress-context-in-conductor-node-dispatch.md (I1 — after 0018)
  - SUV-0025-benchmark-headroom-on-real-workloads-and-set-rollout-defaults.md (I0 benchmarks — after 0023)
  - SUV-0026-user-visible-retrieval-of-compressed-originals.md (I1 — after 0023)
  - SUV-0027-in-app-headroom-savings-and-stats-report-view.md (I1 — after 0023)
  - SUV-0028-token-displays-and-thresholds-read-through-headroom-stats.md (I1 — after 0023)
  - SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md (I2 — after 0018)
  - SUV-0030-memory-extension-interface-designed-and-proposed-upstream.md (I2 — after 0029)
  - SUV-0031-agentic-memory-v2-as-a-plugged-backend-behind-the-interface.md (I2 — after 0030)
  - SUV-0032-vorno-plus-headroom-docs-page.md (last — documents shipped surfaces)
blocked-by: []
---

# PLAN-040 — Integrate Headroom: context compression, token management, memory

> **We are not building a library.** [Headroom](https://github.com/headroomlabs-ai/headroom)
> (Apache-2.0, ~67k stars; Rust core, TypeScript/Python SDKs, local proxy, MCP
> server) is adopted into Vorno's supply chain as **the** context-discipline
> layer: compression, token management, and multi-layer memory. Vorno's work is
> **integration** — plus one deliberate build item: a **pluggable extension
> interface for additional memory storage formats and querying**, where the
> *interface* is the priority, pursued as an upstream contribution first.

## Goal

Long-running and repeated agent work (PLAN-039 workflows especially) runs on
Headroom for context discipline: tool outputs and context compressed
(reversibly, originals retrievable), token behavior measured and managed, and
memory shared across agents — with Vorno's existing memory engine plugged in
*behind Headroom's interface* rather than beside it.

## What Headroom provides (verify at integration time, not from README claims)

- **Compression:** content-aware (JSON / code / prose engines), reversible with
  on-demand retrieval of originals; output-token verbosity steering.
- **Token measurement:** savings/perf analytics (`headroom stats`, dashboard).
- **Memory, multi-layer:** cross-agent shared store (Claude/Codex/Gemini/Grok,
  auto-dedup, provenance) + `headroom learn` (mines failed sessions, writes
  corrections to agent context files). Default substrate: local markdown —
  philosophically aligned with our file-first, human-readable bias (ADR-0027).
- **Extension seams:** pipeline lifecycle hooks (`on_pipeline_event`),
  compression hooks, provider slices, downstream MCP tools.
- **Integration surfaces:** TS/Python libraries, HTTP proxy
  (OpenAI/Anthropic-compatible), MCP server (`headroom_compress`,
  `headroom_retrieve`, `headroom_stats`), framework adapters.

## Scope

### I0 — Adoption + vetting (supply-chain hygiene, not evaluation-to-decide)

The decision to integrate is made. Vetting is about *how safely*, not *whether*:
license/NOTICE audit, network/telemetry behavior audit (it sits in the token
path and sees all context — nothing leaves the machine without explicit
opt-in), version pinning with a documented update cadence (no `latest`
dist-tags — LEARNING-062 class), and benchmarks on real Vorno workloads to set
rollout defaults. Rollout is flag-gated per workspace and reversible; Vorno
must degrade gracefully if Headroom is absent.

### I1 — Integration surface + wiring

- Choose the surface: bias to the **TypeScript SDK in-process** (Vorno is a TS
  codebase; the agent loop and Conductor are ours to instrument); the proxy and
  MCP server remain fallbacks/companions where in-process is wrong. Record the
  choice as a short ADR if it constrains architecture.
- Wire compression into the agent session loop and Conductor node dispatch;
  wire retrieval so reversibility is a user-visible affordance, not just an
  internal cache.
- Vorno's token surfaces (PLAN-002/003 displays and thresholds) read through
  Headroom's stats where they overlap; Vorno-side glue stays thin app code.
  **Any gap found between Vorno's token-management needs and Headroom's
  features is handled as thin glue or an upstream contribution — explicitly
  not a new library.**

### I2 — Memory: adopt the layers, build the extension interface

- Adopt Headroom's multi-layer memory as the memory substrate for agent
  sessions and workflows.
- **The priority build item of this plan:** a **pluggable extension interface
  for additional memory storage formats and querying** — so alternative
  backends (different formats, different query semantics) can sit behind
  Headroom's memory rather than beside it. Design against Headroom's existing
  extension seams (pipeline hooks / provider slices); **pursue it as an
  upstream contribution first** (per the roadmap's standing posture of
  contributing portable improvements upstream), carrying it as a maintained
  patch only if upstream declines.
- **First consumer of that interface:** the private agentic-memory v2 engine
  (gated loads, logged retrieval, PRG trims, archive semantics) plugs in as a
  backend; the `agentic-memory` MCP source becomes a thin host over that
  plugged backend. Its gated semantics become an adapter behavior, not a
  parallel engine.

## Non-goals

- **Building our own compression, token, or memory library.** (Corrected twice
  during planning; recording it so it cannot drift back in: the earlier
  "extract our own OSS library" framing is dead.)
- **Forking Headroom.** Extension via its seams and upstream PRs only.
- **Vector-DB / RAG infrastructure.** A retrieval backend could arrive later
  *through* the extension interface; building one is out of scope.
- **Replacing Vorno's run-log durability.** Conductor persistence (run logs,
  node outputs) is untouched; Headroom manages context, not execution state.

## Open questions (resolve during I0/I1)

1. Integration surface: TS SDK vs proxy vs MCP — and whether Vorno's existing
   MCP source machinery makes the MCP server the cheapest *first* step even if
   the SDK is the end state.
2. The upstream-contribution path for the memory extension interface: what do
   Headroom maintainers accept, and what shape (storage-adapter trait / hook
   contract) fits their architecture?
3. How much of the v2 memory engine's gated behavior (PRG trims, retrieval
   logging, archive markers) expresses cleanly as a backend behind Headroom's
   interface vs. needing interface support upstream.
4. Where budget *enforcement* lives if Headroom's token features are
   measurement-first: thin Vorno glue over `headroom_stats`, or an upstream
   feature request.

## Salvaged from prior plans (PLAN-045 Pass 1)

- **A token percentage is only as true as its denominator.** The fork's own
  model-enumeration work found that `/v1/models` carries no context window, so
  enrichment misses and the model defaults to `contextWindow: 200_000` — wrong
  for a 1M-context model, and every percentage computed from it is a confident
  lie. Any Headroom-backed stat that Vorno's displays consume must carry its own
  denominator or declare it unknown.
  ← `vorno-internal:plans/PLAN-010-live-model-enumeration.md`
- **Threshold precedence is already specified.** `resolveThresholds()` resolves
  per-model override → per-provider → default, with warn < danger validation.
  When PLAN-002/003's surfaces migrate onto Headroom stats, that precedence is
  the contract to preserve, not to redesign.
  ← `PLAN-003-token-usage-thresholds-workspace-settings.md`
- **Do not fabricate what the source does not provide.** Prior orchestration
  work confirmed no SDK percent/total-steps exists and refused to synthesise
  one. The same discipline applies to compression-savings and memory-hit
  statistics: measured or absent, never interpolated.
  ← `vorno-internal:plans/PLAN-008`, `PLAN-009`
- **Frontmatter is free query surface.** The shipped artifact plane parses
  markdown frontmatter into its index, making existing conventions (roadmap
  docs, skills, Obsidian properties) queryable without new schema. Headroom's
  default memory substrate is local markdown; the extension interface's query
  semantics should assume frontmatter is already structured data.
  ← `PLAN-025-artifact-plane-v1.md`

## Acceptance

- [ ] I0: vetting report (license, telemetry/network audit, pinning + update cadence) and benchmark results on real Vorno workloads committed to `roadmap/evidence/`.
- [ ] Headroom integrated behind a per-workspace flag, off by default until benchmarks set defaults; Vorno fully functional with it absent or disabled.
- [ ] A workflow run (PLAN-039) executes with compression active; originals retrievable through a user-visible affordance.
- [ ] Token displays/thresholds (PLAN-002/003 surfaces) read through Headroom stats where they overlap; gaps documented as glue or filed upstream — no new library introduced.
- [ ] Memory extension interface designed against Headroom's seams; upstream contribution opened (or their decline documented and the patch carried with rationale).
- [ ] agentic-memory v2 runs as a plugged backend behind that interface; the MCP source is a thin host over it.
- [ ] Docs: a `vorno.ai/docs` page on Vorno + Headroom — what it does, how to toggle it, what leaves the machine (nothing without opt-in).

## Status log

- `2026-08-22` — created in `planned/` as the second half of the DIR-05 milestone (top roadmap priority).
- `2026-08-22` — reframed once (adoption vs. name-collision misread), then **corrected to final form on product-owner direction: pure integration.** Headroom provides compression, token management, and multi-layer memory; Vorno builds only integration glue plus the pluggable memory-extension interface (formats + querying), interface-first, upstream-first. No library of ours, full stop.
- `2026-08-25` — first breakdown round: SUV-0014..0018 cut covering vendoring/long-term support (vet+pin, boundary module) and the settings surfaces (config schema/storage/precedence, workspace UI, config-driven boundary). I1 compression wiring, benchmarks, token-surface migration, and I2 memory remain undecomposed.
- `2026-08-26` — second breakdown round, to completion: SUV-0023..0032 cut covering the full remainder — I1 compression call sites (session loop 0023, Conductor 0024), I0 benchmarks→defaults (0025), user-visible retrieval (0026), the in-app savings/stats report view (0027), token display/threshold migration onto Headroom stats (0028), I2 memory adoption (0029), the extension interface + upstream contribution (0030), agentic-memory v2 as plugged backend (0031), and the docs page (0032). Every plan acceptance item now maps to at least one SUV.
