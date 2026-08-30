---
id: PLAN-040
title: Integrate Headroom — context compression, token management, and memory
status: in-progress
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-28
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
  - SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md (I2 — after 0018; re-cut 2026-08-28 around ADR-0031's provider seam)
  - SUV-0040-builtin-markdown-memory-provider-with-decay-and-temporal-processing.md (I2 — after 0029; builds the minimal built-in provider out to full semantics)
  - SUV-0030-memory-extension-interface-designed-and-proposed-upstream.md (I2 — after 0029)
  - SUV-0031-agentic-memory-v2-as-a-plugged-backend-behind-the-interface.md (I2 — after 0030)
  - SUV-0032-vorno-plus-headroom-docs-page.md (in-app docs — after the surfaces it documents)
  - SUV-0033-publish-headroom-docs-page-to-vorno-site.md (last — publishes 0032's page to the web; spans vorno-site)
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
  corrections to agent context files).
  **CORRECTED 2026-08-26 by integration-time verification (SUV-0029) — this
  bullet previously claimed "Default substrate: local markdown — philosophically
  aligned with our file-first, human-readable bias (ADR-0027)". That is not what
  Headroom does.** The substrate is a project-scoped **SQLite** database
  (`.headroom/memory.db`) carrying an HNSW vector index and an FTS5 full-text
  index. Nor is memory reachable from the pinned TypeScript SDK, the proxy's
  HTTP API, or the MCP server: it is exposed only via `headroom wrap --memory`,
  the Python client's `client.memory.*`, and proxy-injected
  `memory_save`/`memory_search` model tools.
  **RESOLVED 2026-08-27 by [ADR-0029](../../decisions/0029-headroom-memory-via-host-invoked-mcp.md),
  which supersedes this correction's two open consequences.** (i) The
  ADR-0027 alignment is **relocated, not abandoned**: what Vorno commits to is a
  memory *interface* whose behaviour is inspectable and tunable in settings; how
  a given backend stores its bytes is that backend's implementation detail.
  SQLite + HNSW + FTS5 underneath is accepted on those terms. (ii) The vector
  index is therefore **not** the "Vector-DB / RAG infrastructure" non-goal below
  — that non-goal forbids *building* one, and we are adopting one that exists.
  (iii) A fifth surface, missed by the audit above, is the one chosen: the
  memory **MCP stdio server** (`headroom.memory.mcp_server`), which ships in the
  pinned 0.36.5 and is host-invoked from the boundary adapter. Evidence:
  [`roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md`](../../evidence/PLAN-040/headroom-memory-surface-audit.md).
- **Extension seams:** compression hooks.
  **CORRECTED 2026-08-27 by SUV-0030's verification against the pinned package —
  this bullet previously named four seams: "pipeline lifecycle hooks
  (`on_pipeline_event`), compression hooks, provider slices, downstream MCP
  tools". For the TypeScript SDK, exactly one of the four is real.**
  `on_pipeline_event` does not exist in `headroom-ai@0.36.5` — the only
  `pipeline` token in the package is `pipelineTiming`, a stats field — and
  "downstream MCP tools" is not a seam of that package. Compression hooks are
  genuine; a related upstream bug is reported in the same issue
  ([#3287](https://github.com/headroomlabs-ai/headroom/issues/3287)):
  `CompressionHooks.computeBiases` is documented but inert on `main` (`biases`
  is assigned, never read). The real extension seams live Python-side —
  `headroom/memory/ports.py`'s Protocols plus `factory.py`'s setuptools
  entry-point routing — which is what SUV-0030 designed against.
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
  **Settled 2026-08-27.** Compression rides the TS SDK in-process as biased
  here. **Memory does not — it has no TypeScript surface to ride** — and is
  taken through the memory MCP stdio server, host-invoked from the same boundary
  adapter, per [ADR-0029](../../decisions/0029-headroom-memory-via-host-invoked-mcp.md).
  Open question 1 is closed; an upstream TypeScript memory path remains the
  preferred end state and is filed as gap D of
  [#3287](https://github.com/headroomlabs-ai/headroom/issues/3287).
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
  **CORRECTED 2026-08-28 by [ADR-0031](../../decisions/0031-vendor-neutral-memory-provider-seam.md) —
  Headroom is one provider, not the substrate.** Memory lands behind a
  vendor-neutral, **host-invoked** `MemoryProvider` seam
  (`search`/`save`/`describe`); the first slice ships two providers,
  `headroom-mcp` (ADR-0029's surface, unchanged underneath) and a
  `builtin-markdown` default, with agentic-memory as the third. "Adopt the
  layers" survives as "adopt Headroom as a provider"; what does not survive
  is memory as a feature of the `HeadroomAdapter` behind `HeadroomConfig.enabled` —
  that shape would have made every future engine swap a migration through the
  boundary module, the config schema, and the settings surface. The re-cut is
  free precisely because SUV-0029 has zero implementation to migrate.
  **SHIPPED 2026-08-28 by SUV-0029 + SUV-0040.** The seam is
  `packages/core/src/types/memory-provider.ts`; the two providers are
  `builtin-markdown` (default, zero provisioning) and `headroom-mcp`; the host
  calls them from `BaseAgent.chat()`. Headroom is now, in code and not only on
  paper, one provider among several.
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
  **AMENDED 2026-08-28 by [ADR-0031](../../decisions/0031-vendor-neutral-memory-provider-seam.md):**
  the `builtin-markdown` default memory provider (SUV-0040) is a deliberate,
  bounded carve-out — a provider implementation behind the seam (markdown +
  frontmatter, lexical retrieval, no embeddings, no vector index), not a
  memory platform. SUV-0029's three blocked passes invoked this non-goal
  against writing a markdown substrate ourselves; the ADR records why the
  carve-out does not reopen that door. The non-goal still forbids the library
  ambition; it no longer forbids the default provider.
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
  docs, skills, Obsidian properties) queryable without new schema. The
  extension interface's query semantics should assume structured metadata is
  already available, and should express it through Headroom's own
  `metadata_filters` / `entity_refs` rather than inventing a parallel vocabulary.
  **CORRECTED 2026-08-27: this bullet previously justified itself with
  "Headroom's default memory substrate is local markdown" — the same false claim
  struck from the capability list on 2026-08-26. The recommendation survives and
  is re-grounded above; the stated reason did not.**
  ← `PLAN-025-artifact-plane-v1.md`

## Acceptance

- [x] I0: vetting report (license, telemetry/network audit, pinning + update cadence) and benchmark results on real Vorno workloads committed to `roadmap/evidence/`.
- [x] Headroom integrated behind a per-workspace flag, off by default until benchmarks set defaults; Vorno fully functional with it absent or disabled.
- [x] A workflow run (PLAN-039) executes with compression active; originals retrievable through a user-visible affordance.
- [x] Token displays/thresholds (PLAN-002/003 surfaces) read through Headroom stats where they overlap; gaps documented as glue or filed upstream — no new library introduced.
- [x] Memory extension interface designed against Headroom's seams; upstream contribution opened (or their decline documented and the patch carried with rationale).
- [x] agentic-memory v2 runs as a plugged backend behind that interface; the MCP source is a thin host over it.
- [~] Docs: a `vorno.ai/docs` page on Vorno + Headroom — what it does, how to toggle it, and what leaves the machine (nothing without opt-in, save the one-time embedder model fetch on first enable, which is disclosed). **This item is discharged by two SUVs, not one:** SUV-0032 authors the page into the in-app docs tree, and SUV-0033 publishes it to the site. In-app content alone does not discharge it — the acceptance says `vorno.ai/docs`, and a guide written for a filesystem stays valid on disk while breaking on the web. **Status 2026-08-28: the in-app half is complete and now spans two pages** (`headroom.md` plus `memory.md`, which it links to); **the publish half is owner-gated**, not merely unfinished — see SUV-0033 in `blocked/`. Marked `[~]` rather than `[x]` deliberately: ticking it would claim something is on the web that is not.

## Status log

- `2026-08-22` — created in `planned/` as the second half of the DIR-05 milestone (top roadmap priority).
- `2026-08-22` — reframed once (adoption vs. name-collision misread), then **corrected to final form on product-owner direction: pure integration.** Headroom provides compression, token management, and multi-layer memory; Vorno builds only integration glue plus the pluggable memory-extension interface (formats + querying), interface-first, upstream-first. No library of ours, full stop.
- `2026-08-25` — first breakdown round: SUV-0014..0018 cut covering vendoring/long-term support (vet+pin, boundary module) and the settings surfaces (config schema/storage/precedence, workspace UI, config-driven boundary). I1 compression wiring, benchmarks, token-surface migration, and I2 memory remain undecomposed.
- `2026-08-26` — **I2's premise did not survive integration-time verification, and the "Memory, multi-layer" bullet above is corrected in place.** SUV-0029 audited the pinned SDK against this plan's own instruction ("verify at integration time, not from README claims") and found no memory API in `headroom-ai@0.36.5` at all — no `/v1/memory*` endpoint, no client member, no filesystem access, and no mention of memory in its README. Memory is a proxy/CLI feature reached only through `headroom wrap --memory`, the Python client, or proxy-injected model tools; its substrate is SQLite + HNSW + FTS5, not local markdown. **SUV-0029 is blocked**, and SUV-0030 (the plan's priority build item) and SUV-0031 inherit the premise and need re-grounding. Unblocking requires an architectural decision — which Headroom surface provides memory — that §I1 already contemplated as an ADR; the recommendation is the upstream-contribution route, consistent with this plan's upstream-first posture. Evidence and the four options considered: [`roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md`](../../evidence/PLAN-040/headroom-memory-surface-audit.md).
- `2026-08-27` — **SUV-0030 delivered, and it inverts I2's premise in the favourable direction: the "priority build item" of this plan largely exists upstream already.** `headroom/memory/ports.py` defines the `MemoryStore` / `VectorIndex` / `TextIndex` / `Embedder` / `MemoryCache` / `GraphStore` Protocols; `config.py` carries `EXTERNAL` on all three storage backend enums; `factory.py` loads third-party backends from setuptools `entry_points`. §I2's build item therefore shrinks from "design a pluggable extension interface" to **four additive gaps** taken upstream as [headroomlabs-ai/headroom#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) (retrieval context, withheld/refused envelope, compression-surviving annotations, a TypeScript path) plus a docs PR. Design, on-paper backend walk, and the dated follow-up plan for open question 2: [`roadmap/evidence/PLAN-040/memory-extension-interface-design.md`](../../evidence/PLAN-040/memory-extension-interface-design.md). **Two corrections owed to this file, deliberately not applied in place pending the owner's read** (doc §4): (a) the *Salvaged from prior plans* frontmatter bullet justifies itself with "Headroom's default memory substrate is local markdown" — the same false claim already struck from the capability list on 2026-08-26; the bullet's *recommendation* is sound and re-grounded on `metadata_filters`/`entity_refs`, its *reason* is not. (b) The **"Extension seams"** bullet above is wrong for the TypeScript SDK: `on_pipeline_event` does not exist in `headroom-ai@0.36.5` (the only `pipeline` token is `pipelineTiming`, a stats field), and "downstream MCP tools" is not a seam of that package. Exactly one of the four named seams — compression hooks — is a real extension point there. Related upstream bug reported in the same issue: `CompressionHooks.computeBiases` is documented but inert on `main` (`biases` assigned, never read).
- `2026-08-27` — **Open question 1 closed by [ADR-0029](../../decisions/0029-headroom-memory-via-host-invoked-mcp.md); the I2 stall is over.** The memory surface is Headroom's **memory MCP stdio server**, host-invoked from the `HeadroomAdapter` boundary — a fifth option all three SUV-0029 audit passes missed because they reasoned about the npm bundle and upstream's wiki, never the installed Python package. `headroom/memory/mcp_server.py` ships **in the pinned 0.36.5**, exposes `memory_search`/`memory_save`, and launches as `python -m headroom.memory.mcp_server` with **no `headroom wrap` in the path** — which is what makes the F3 posture structural rather than argued. Verified by driving it over real stdio JSON-RPC: `initialize` → `tools/list` → save two facts → search returned both, ranked. **That is this plan's first working memory round-trip.** Three constraints came with it and are carried into the ADR and SUV-0029's re-cut: a third lifecycle state (**installed but unprovisioned** — the ONNX embedder needs an ~86 MB HuggingFace model while the server forces `HF_HUB_OFFLINE=1`, so it advertises both tools while both fail); the surface **collapses four-layer scoping to USER only** (`session_id`/`agent_id`/`turn_id` NULL on disk); and **reads are prose, not structured**. The latter two join the LocalBackend-bypass gap on [#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) at the 9/3 bump. Two corrections owed to this file since 2026-08-27 are now **applied in place** (owner-read condition met): the *Salvaged* frontmatter bullet's false justification struck and its recommendation re-grounded on `metadata_filters`/`entity_refs`, and the *Extension seams* bullet reduced from four named seams to the one that is real. Acceptance item 7 is re-scoped: it takes **two** SUVs, and SUV-0033 is cut to own the site-side publish that no SUV on this branch could.
- `2026-08-26` — second breakdown round, to completion: SUV-0023..0032 cut covering the full remainder — I1 compression call sites (session loop 0023, Conductor 0024), I0 benchmarks→defaults (0025), user-visible retrieval (0026), the in-app savings/stats report view (0027), token display/threshold migration onto Headroom stats (0028), I2 memory adoption (0029), the extension interface + upstream contribution (0030), agentic-memory v2 as plugged backend (0031), and the docs page (0032). Every plan acceptance item now maps to at least one SUV.
- `2026-08-28` — **[ADR-0031](../../decisions/0031-vendor-neutral-memory-provider-seam.md) generalizes the memory seam one layer above ADR-0029; SUV-0029 re-cut around it, SUV-0040 cut for the built-in provider.** ADR-0029 stands unchanged — its host-invoked MCP surface and constraints C1/C2/C3 all hold — but the layer above it was about to be built vendor-shaped: SUV-0029 as written bolted `memorySearch`/`memorySave` onto `HeadroomAdapter` behind `HeadroomConfig.enabled`, making memory a *feature of Headroom* rather than a capability with providers. ADR-0031 names the seam instead: a vendor-neutral, host-invoked `MemoryProvider` (`search`/`save`/`describe`), with Headroom demoted to one provider (`headroom-mcp`) and a `builtin-markdown` default provider that restores ADR-0027's file-first alignment *literally at the storage layer* for the default path — no Python, no model fetch, no egress, and C1's unprovisioned state structurally impossible there (honest cost, stated not hidden: lexical retrieval, not semantic). The existence proof is already running in this workspace: the `agentic-memory` MCP source is structurally identical to Headroom's memory MCP server — and, ironically, being an ordinary source today its tools are *model-invoked*, the exact adherence-dependence ADR-0029 rules out; as the third provider it becomes host-invoked too. `describe()` exists because C1/C2/C3 taught us providers have shapes the host must degrade around rather than assume; host-invocation is what makes deterministic composition (fan-out search, mirrored writes) possible at all. The re-cut is free because SUV-0029 has **zero implementation** — three blocked passes wrote audits and tripwires, never source; naming the seam correctly before writing it costs nothing, after it would be a migration through the shipped settings surface and the boundary lint. §I2's substrate bullet corrected in place above; the first non-goal amended with the bounded carve-out; SUV-0040 added to the breakdown (after 0029, which it is blocked by).
- `2026-08-28` — **The plan's memory half is built. SUV-0029 and SUV-0040 both
  executed and moved to `done/`; six of seven plan acceptance items are ticked,
  and the seventh is owner-gated rather than unfinished.** `planned/` →
  `in-progress/`.

  **What landed.** ADR-0031's `MemoryProvider` seam (`search`/`save`/`describe`),
  a provider registry, two real providers in-tree, host-invoked calls at
  `BaseAgent.chat()`'s context assembly and turn exit, a memory config schema
  and workspace settings section that surfaces each provider's *declared*
  capabilities including its limitations, a docs page, and the boundary gate's
  missing second direction. 239 new tests. Detail lives in the two SUV logs
  rather than here; what belongs at plan level is the shape:

  **§I2's "priority build item" has now resolved twice, in opposite directions,
  and both resolutions stand.** SUV-0030 found the *Headroom-internal* extension
  interface already existed upstream (`ports.py` Protocols + setuptools entry
  points), shrinking that build item to four additive gaps filed as
  [#3287](https://github.com/headroomlabs-ai/headroom/issues/3287). ADR-0031 then
  named a *second, Vorno-side* seam one layer above it. These are not competing
  answers — they are the two pluggability layers ADR-0031 commitment 5 warns not
  to confuse, and this plan now has both.

  **The non-goal carve-out was exercised, and stayed narrow.** `builtin-markdown`
  is ~700 lines of provider across five focused modules: markdown files,
  frontmatter, lexical retrieval, decay, archive. No embeddings, no vector index,
  no public API beyond the seam, no library. The AMENDED non-goal above predicted
  exactly this boundary and it held — worth recording, because a carve-out that
  quietly widens is how "we are not building a library" becomes a library.

  **Three integration-time defects, consistent with this plan's standing
  instruction to verify rather than trust.** (1) Headroom's memory server
  resolves its database **from the current working directory** — for a desktop
  app, wherever it was launched from; now pinned with `--db` into the workspace.
  (2) An explicit interpreter path was treated as a first guess rather than as
  authoritative. (3) `describe()` initially reported every failing probe as the
  C1 "unprovisioned" state, including a database error that no model download
  would fix. All three were found by tests, none by review. The first is the kind
  of thing that ships and then produces a bug report reading "my memories
  disappeared", which is worth more than the two-line fix suggests.

  **On sequencing:** SUV-0040 was `blocked-by` SUV-0029 and both shipped in one
  pass. The split was about scope legibility, not ordering — SUV-0029 needed a
  second real provider to demonstrate vendor-neutrality at all, and a
  `builtin-markdown` without depth would have been written twice. Each kept its
  own acceptance list and each is ticked on its own evidence.

  **What is left, precisely.** Acceptance item 7 is `[~]`: the in-app docs are
  complete and now span two pages, but `vorno.ai/docs` does not yet carry them.
  SUV-0033 owns that publish, is moved to `blocked/`, and its `blocked-by` names
  the owner gate — publishing to the site is outward-facing and timed against
  announcements, so it is Jeff's call, not an oversight. Every other SUV under
  this plan is in `done/`.
