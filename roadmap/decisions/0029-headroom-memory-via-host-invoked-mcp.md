---
id: ADR-0029
title: Headroom memory through the memory MCP stdio server, host-invoked from the boundary adapter
status: accepted
date: 2026-08-27
supersedes: []
superseded-by: []
---

# ADR-0029 — Headroom memory through the memory MCP stdio server, host-invoked from the boundary adapter

## Context

PLAN-040 adopts Headroom as Vorno's context-discipline layer. Its §I2 adopts
Headroom's multi-layer memory as the substrate for sessions and workflows, and
its open question 1 — "integration surface: TS SDK vs proxy vs MCP" — was
explicitly reserved for an ADR. This is that ADR.

**The premise §I2 was written on did not survive integration-time verification.**
SUV-0029 was attempted three times and blocked three times, each pass
re-deriving the finding independently rather than trusting its predecessor:

- The pinned TypeScript SDK, `headroom-ai@0.36.5`, has **no memory API**. Its
  `dist/index.d.ts` export list carries exactly three memory-named symbols —
  `MemoryUsage` / `memoryUsage()` (the proxy process's RSS, unrelated) and the
  path helpers `memoryDbPath()` / `nativeMemoryDir()`. There is no `memory`
  member on `HeadroomClient`; the sixteen `/v1/*` literals in the bundle contain
  no `/v1/memory*`; the package performs no filesystem access at all.
- `nativeMemoryDir()` — the last plausible candidate for a markdown substrate —
  is a dead path string. Both helpers are pure `joinPath` calls.
- The substrate is **SQLite** (`memory.db`), not the local markdown §I2's
  capability list claimed. That claim was struck from PLAN-040 on 2026-08-26.
- A matched Headroom **CLI is installed** at the same version (0.36.5), and
  `headroom memory` is real — but it exposes only administration verbs
  (`list`/`show`/`stats`/`edit`/`delete`/`prune`/`purge`/`reindex`/`export`/
  `import`/`repair-supersession`). **No `add`, no `search`.** It is not a
  write/query surface an integration can build on.

Evidence: [`roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md`](../evidence/PLAN-040/headroom-memory-surface-audit.md)
(findings M1–M7).

**What the prior audit passes missed.** All three reasoned about the *npm
bundle* and the upstream wiki. Neither looked inside the installed *Python*
package. `headroom/memory/mcp_server.py` ships **in the pinned 0.36.5** — a
stdio MCP server exposing `memory_search` and `memory_save` over the memory
backend. Upstream's own `headroom wrap` writes exactly this invocation into
its generated MCP config (`cli/wrap.py:3064-3066`), so it is a shipped,
exercised entry point rather than an internal detail.

That reframes the option space. The four routes SUV-0029 named were
proxy-injected model tools, the Python client, direct `memory.db` reads, and an
upstream TypeScript contribution. A fifth was available the whole time and is
strictly better than the first three.

### Forces

- **F3 (trust-zone posture).** Vorno must not route completions or provider
  credentials through a third-party process. This is a property of the
  architecture, not of a particular deployment.
- **Upstream-first.** PLAN-040's standing posture: contribute portable
  improvements rather than fork or carry patches.
- **Degrade gracefully.** Vorno must be fully functional with Headroom absent,
  unprovisioned, or disabled.
- **Don't build a memory library.** PLAN-040's first non-goal. Writing our own
  persistence to satisfy an acceptance item is out.
- **ADR-0027 alignment is at the interface, not the storage engine.** §I2
  originally justified adopting this layer by a claimed markdown substrate
  "philosophically aligned with our file-first bias (ADR-0027)". That
  justification was false, but the alignment it reached for is preserved at the
  level that matters: what Vorno commits to is a *memory interface* whose
  behaviour is inspectable and tunable in settings. How a given backend stores
  and retrieves bytes underneath is an implementation detail of that backend.
  A SQLite store with vector and full-text indexes underneath is therefore
  **not** a violation (SQLite and FTS5 observed; HNSW documented but unverified,
  since `vector_backend` defaults to `AUTO` — audit M7e), and the
  vector index is not the "Vector-DB / RAG infrastructure" PLAN-040 rules out as
  a *build* non-goal — we are adopting one that exists, not building one.

## Decision

**Vorno consumes Headroom memory through Headroom's memory MCP stdio server
(`headroom.memory.mcp_server`), invoked by the host from inside the
`HeadroomAdapter` boundary.**

Elaboration, in the six commitments this makes:

**1. Host-invoked, not model-adherence-dependent.** MCP is JSON-RPC over stdio
and the host owns the client. The adapter calls `memory_search` / `memory_save`
**deterministically at defined lifecycle points** — session context load, save
points, Conductor node dispatch — and splices results into prompts. Exposing the
same tools to the model as callable tools is a **layered option**, not the
foundation. The irony is worth recording: Headroom's own native mode
(proxy-injected tools) is the adherence-dependent one, and it is the one we rule
out.

**2. Deliberately narrow: `memory_search` + `memory_save` only.** Update,
delete, supersession, and history remain Python-client / CLI-admin territory.
The interface shape lands narrow and widens later via small additive upstream
PRs. This is a deliberate scoping call, not a gap we failed to notice.

**3. Pluggable backends are the planned extension, not the first step.**
agentic-memory v2 **cannot** plug in behind this surface yet — but the reason is
narrower than it first appeared, and the precise version matters because it
determines the upstream ask. The MCP server does **not** bypass `factory.py`:
`core.py:124` calls `create_memory_system(config)` and the factory is reached.
The problem is that `LocalBackendConfig` (`backends/local.py:37-66`) has **no
`store_backend` field**, so the `MemoryConfig` built at `backends/local.py:186-195`
leaves it at the `StoreBackend.SQLITE` default (`config.py:99`) and
`factory.py:128` always takes the SQLite branch. The `EXTERNAL` entry-point
branch is live and correct; it is merely unreachable from this path.

**The ask upstream is therefore "let `LocalBackendConfig` and the memory MCP
server name a store backend", not "route the MCP server through the factory"** —
the latter would be rejected as already done. Appended as an additional gap to
[headroomlabs-ai/headroom#3287](https://github.com/headroomlabs-ai/headroom/issues/3287)
at the 2026-09-03 bump. See audit finding M7c for the full trace.

**4. Options 1 and 3 are ruled out on posture, not effort.** See *Alternatives*.
Relatedly, `headroom wrap`-dependent features — `headroom learn`, cross-agent
dedup — are **out of scope** for the same F3 reason.

**5. Packaging, decided once for compression and memory.** Python is a **runtime
prerequisite of the feature being on**, never a shipped dependency of Vorno.
Server-hosted: bake Headroom into the container image. Desktop: **opt-in,
detect-and-enable** with a settings surface and a documentation lift, following
the `rtk` pattern. No Python bundling into the Electron app. There is no
standalone Rust binary to ship — `binaries.py` fetches only a pinned
`ast-grep-cli` helper; the runtime is the Python package.

**6. Forward note to PLAN-041** (per its standing "server-homed consequences"
rule): per-workspace `memory.db` is SQLite and single-writer, so it intersects
the run-leasing/storage question; `memory.db` becomes hosted user data, so the
privacy-policy gate applies; and the MCP route keeps trust zones clean — the
memory server sees content, never credentials.

### Verified, not assumed

Every claim below was reproduced first-hand on 2026-08-27 against the installed
pinned 0.36.5, by driving the server over real stdio JSON-RPC — not read from
upstream documentation:

- `initialize` → `serverInfo {"name":"headroom-memory","version":"1.29.1"}`
- `tools/list` → `['memory_search', 'memory_save']`
- `memory_save` two facts → `Saved 2 new, updated 0 existing (2 total)`
- `memory_search` → both returned, ranked (`relevance=0.50`, `relevance=0.16`)

**This is PLAN-040's first working memory round-trip.** The three prior SUV-0029
passes established what does not exist; this establishes what does.

It launches as `python -m headroom.memory.mcp_server --db <path> --user <id>` —
**no `headroom wrap` anywhere in the path**, which is what makes the F3 posture
clean in fact rather than merely in argument.

### Three constraints this surface imposes

Discovered during the same verification, and load-bearing for the SUVs
downstream of this ADR:

**C1 — There is a third state: installed but unprovisioned.** The embedder is
hardwired to `embedder_backend="onnx"` and requires
`Qdrant/all-MiniLM-L6-v2-onnx` (~86 MB) from HuggingFace Hub, while
`mcp_server.main()` sets `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` via
`setdefault`. On a machine with the CLI installed and a populated `~/.headroom/`
but no cached model, the server **handshakes correctly and advertises both
tools while both tool calls return `isError: true`** — "cannot find the
requested files in the local cache". Re-running with `HF_HUB_OFFLINE=0` fetched
the model and every call passed.

Consequences: detecting the Headroom binary is **not** sufficient to conclude
memory works; the enable gate must probe provisioning. First enable performs a
~86 MB fetch from HuggingFace — a public model download, not telemetry, but
genuine outbound egress. **It is disclosed in the docs page, not gated behind a
consent prompt** (owner decision, 2026-08-27). SUV-0032's "nothing leaves the
machine without opt-in" needs a carve-out sentence naming it. Server-hosted
images must bake the **model**, not merely `pip install headroom`.

**C2 — This surface collapses multi-layer memory to the USER layer.**
`_handle_save` passes only `content` / `user_id` / `importance`. Verified on
disk: `session_id`, `agent_id`, and `turn_id` are **NULL** on saved rows. The
schema supports the four-layer scoping (USER → SESSION → AGENT → TURN) that
upstream advertises as a differentiator and that PLAN-040 §I2 reached for; the
MCP surface does not expose it. Filed as a #3287 gap.

**C3 — Reads are prose, not structured.** `memory_search` returns
`"1. [relevance=0.50] <content>"` text with an optional `Related:` line. There
is no structured `entity_refs` / `metadata` in the response, so
"provenance-carrying reads" degrade to a formatted string. Filed as a #3287 gap.

C2 and C3 are consistent with commitment 2 (start narrow) — but they are
narrowings of an advertised capability, named here so no downstream SUV assumes
otherwise.

## Consequences

### Positive

- **Memory works now**, on the version already pinned, with no upstream
  dependency and no waiting on maintainer timelines.
- **F3 is preserved structurally.** Completions and provider credentials never
  traverse Headroom. The memory server sees memory content and nothing else.
- **Protocol plumbing, not lifecycle invention.** Vorno already supervises stdio
  MCP subprocesses; this is an instance of a solved problem rather than a bespoke
  sidecar with its own supervision story.
- **Reversible.** The adapter boundary means the surface can be swapped for the
  upstream TypeScript path (alternative D) without touching call sites.
- **The SUV-0014 tripwire keeps its teeth.** A memory API appearing in the TS
  SDK still turns the monthly bump red, which is now an *upgrade* signal rather
  than an unblock signal.

### Negative

- **Python becomes a runtime prerequisite** for the feature being on. Mitigated
  by commitment 5, not eliminated.
- **A ~86 MB first-run model fetch** (C1), and a genuinely new "installed but
  unprovisioned" failure mode that the degrade path must handle distinctly from
  "absent".
- **agentic-memory v2 cannot plug in yet** (commitment 3). SUV-0031's plugged
  backend is real against `factory.py` but unreachable *through this surface*
  until `LocalBackendConfig` can carry a store-backend choice.
- **The boundary gate does not yet cover this seam.** `check-headroom-boundary.ts`
  matches package *imports*, so it cannot see a subprocess launched as
  `python -m headroom.memory.mcp_server`. The gate needs a second pattern before
  SUV-0029 lands, or the boundary becomes enforceable in one direction only.
- **Multi-layer memory is not actually multi-layer through this surface** (C2),
  so §I2's "memory shared across agents" is delivered only at USER granularity
  for now.
- **ADR-0027's literal file-first bias is not honoured** at the storage layer.
  Accepted deliberately: the alignment is relocated to the interface, per
  *Forces*.

### Neutral

- **Two processes to observe** rather than one. Startup latency includes embedder
  warm-up.
- **`memory.db` is SQLite and single-writer** — fine per-workspace on the
  desktop, an explicit input to PLAN-041's run-leasing design when server-homed.
- The MCP server reports `serverInfo.version` as **1.29.1** while the package is
  0.36.5. An upstream versioning quirk; harmless, but do not key anything off it.

## Alternatives considered

- **A — Proxy-injected `memory_save`/`memory_search` model tools** (Headroom's
  native mode). **Rejected on posture.** It requires routing completions through
  Headroom's proxy, which carries provider credentials — an F3 violation in *any*
  deployment, not merely the hosted one. Additionally adherence-dependent: memory
  happens only if the model elects to call the tool.
- **B — The Python client (`client.memory.*`, via `with_memory()`).** This is
  the surface upstream's wiki documents, and it is real — it is simply Python,
  and wraps an OpenAI client, which re-imports the F3 problem when used as
  documented. Rejected as the *foundation*; remains the admin/CLI path for the
  verbs commitment 2 leaves out.
- **C — Read `memory.db` directly.** **Rejected on posture.** Reverse-engineering
  a pre-1.0 schema, coupling Vorno to internals with no compatibility promise,
  and bypassing the supersession and access-recording logic the server applies.
- **D — Contribute a TypeScript/HTTP memory path upstream** (gap D of #3287).
  **Not rejected — this is the preferred END STATE**, and this ADR is the bridge
  to it, not a competitor. A Route-A PR (proxy `/v1/memory/*` endpoints
  marshalling to the existing `MemorySystem.handle_memory_*` facade, plus thin
  TS client methods) is viable and would be welcome upstream; evidence that the
  project merges external work quickly is the `/v1/usage` endpoint PR merged
  2026-08-26 and six distinct external contributors merged in the preceding five
  days. Rejected only as the *first* step, because it makes shipping §I2
  contingent on someone else's review queue.

## References

- [PLAN-040 — Integrate Headroom](../plans/in-progress/PLAN-040-integrate-headroom.md) (§I1 surface choice, §I2 memory, open question 1)
- [SUV-0029 — Memory provider seam with Headroom MCP and built-in markdown providers](../suvs/done/SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md) (unblocked and re-cut by this ADR; re-cut again 2026-08-28 under ADR-0031)
- [SUV-0030 — Memory extension interface designed and proposed upstream](../suvs/done/SUV-0030-memory-extension-interface-designed-and-proposed-upstream.md)
- [SUV-0031 — agentic-memory v2 as a plugged backend](../suvs/done/SUV-0031-agentic-memory-v2-as-a-plugged-backend-behind-the-interface.md)
- [Headroom memory surface audit](../evidence/PLAN-040/headroom-memory-surface-audit.md) (M1–M7)
- [Memory extension interface design](../evidence/PLAN-040/memory-extension-interface-design.md)
- [ADR-0027 — Lean on the OS for lifecycle chores](0027-lean-on-the-os-for-lifecycle-chores.md) (alignment relocated to the interface)
- [headroomlabs-ai/headroom#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) — the additive gaps, incl. the LocalBackend bypass, scope parameters, and structured results
- [ADR-0031 — Memory behind a vendor-neutral, host-invoked MemoryProvider seam](0031-vendor-neutral-memory-provider-seam.md) (generalizes the layer above this surface: Headroom becomes one provider behind the vendor-neutral MemoryProvider seam)
