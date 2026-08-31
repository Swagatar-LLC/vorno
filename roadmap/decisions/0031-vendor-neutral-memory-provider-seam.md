---
id: ADR-0031
title: Memory behind a vendor-neutral, host-invoked MemoryProvider seam; Headroom is one provider
status: accepted
date: 2026-08-28
supersedes: []
superseded-by: []
---

# ADR-0031 — Memory behind a vendor-neutral, host-invoked MemoryProvider seam; Headroom is one provider

## Context

**ADR-0029 decided how Vorno talks to Headroom's memory. It did not decide —
and quietly presupposed — that Headroom's memory is the only memory.** This ADR
generalizes the layer above that surface: memory becomes a *capability with
providers*, and Headroom becomes one provider behind a vendor-neutral seam.
ADR-0029 stands unchanged underneath it — its surface choice (the memory MCP
stdio server, `python -m headroom.memory.mcp_server`), its host-invoked
argument, and its three constraints C1/C2/C3 all hold, which is why
`supersedes:` is empty.

**The shape being corrected.** `HeadroomAdapter`
(`packages/core/src/types/headroom-adapter.ts:212`, implementations in
`packages/shared/src/headroom/`) is `{ kind, compress, retrieve, stats }` —
shaped around *compression*, named for a *vendor*. SUV-0029 as re-cut after
ADR-0029 bolts `memorySearch` / `memorySave` onto that same adapter, behind the
same master switch (`HeadroomConfig.enabled`,
`packages/core/src/types/headroom.ts:51` — "Nothing else in this object has any
effect while false"). That makes memory **a feature of Headroom** rather than a
capability Headroom happens to provide. Swapping engines under that shape means
touching the Headroom boundary module, the Headroom config schema, and the
Headroom settings section — three surfaces that have nothing to do with what
memory *is*.

**Why now costs nothing.** SUV-0029 has **zero implementation**. Its status log
records three execution attempts, each ending `blocked/` with the explicit
closing line "No source file was created, edited, moved, or deleted." Naming
the seam correctly before writing it is free; naming it after would be a
migration through a shipped settings surface (SUV-0016/0017) and a boundary
lint.

**The seam is already proven viable — Vorno runs a second memory system
today.** The user's workspace source `agentic-memory` (workspace config at
`~/.craft-agent/workspaces/my-workspace/sources/agentic-memory/config.json`,
observed 2026-08-28 — machine-local configuration, not a repo file) is
`type: "mcp"`, `transport: "stdio"`, launching a venv `python3` on
`server/mcp_server.py` with `--data-root ~/dev/agentic-memory`. Structurally
identical to Headroom's memory MCP server invocation: a stdio subprocess
speaking MCP, supervised by machinery Vorno already has. Two memory engines,
one wire shape — that is a seam asking to be named.

**The irony, worth recording.** Because `agentic-memory` is an ordinary MCP
source today, its tools are *model-invoked* — memory happens only if the model
elects to call the tool. That is adherence-dependence, exactly the architecture
ADR-0029's commitment 1 rules out for memory. The seam fixes this for it too:
as a provider it becomes host-invoked at the same lifecycle points as everyone
else.

**Vorno has no in-process plugin system, and this ADR does not invent one.**
Verified 2026-08-28: every `await import()` in the codebase uses a static
specifier; no `vm`, no `new Function`, no runtime-resolved module paths.
`StorageProvider` — the closest prior "provider seam" — has exactly one
implementation, hardcoded at `packages/shared/src/artifacts/roots.ts:64`
(`return new FilesystemStorageProvider(rootId, path)`). Messaging adapters are
three static imports. Vorno's real extension mechanism is **out-of-process MCP
sources** (`SourceType = 'mcp' | 'api' | 'local'`,
`packages/shared/src/sources/types.ts:16`) plus data-level skills and
automations. The seam therefore rides the existing MCP-source machinery for
out-of-process providers; the one in-process provider is in-tree TypeScript,
statically imported — consistent with the no-plugin-system reality, not an
exception to it.

**The non-goal tension, named rather than stepped around.** PLAN-040's first
non-goal is "Building our own compression, token, or memory library", and
SUV-0029's status log invoked it three times — once per blocked attempt —
against writing a markdown substrate ourselves. This ADR carves the exception
deliberately and narrowly, in the Decision below: a bounded *default provider*
is not a memory library, and the corpus would contradict itself if the carve
were left implicit.

### Survey: why third-party engines are providers, not backends

Completed 2026-08-27/28 (13 agents, adversarially verified; findings recorded
here — no separate evidence file exists). Eight third-party memory systems were
surveyed against two candidate integration shapes: as Headroom Python *storage
backends* behind `ports.py`, or as *providers* behind a host-invoked contract.
Conclusion: **none should become a Headroom storage backend** — they are memory
*platforms* that perform LLM extraction on write, so a store-level
`save() -> id` has no clean answer for them. As providers over MCP behind a
host-invoked contract, they are exactly the right shape. Notable verified
specifics:

- **supermemory** — the self-hosted server is a closed-source binary with an
  undocumented 10k-document cap, and requires a provider key to boot.
- **mem0** — `infer=False` does **not** stop egress (content is still POSTed to
  `/v1/embeddings`), and PostHog telemetry ships on by default.
- **honcho** — `ConclusionCreate` accepts only four fields, so supersession is
  unemulatable there.
- **hindsight** (MIT, 21.6k stars) — a true in-process `MemoryEngine` with
  genuinely local embeddings; the strongest future provider candidate of the
  eight.

## Decision

**Vorno's memory operations go behind a vendor-neutral, host-invoked
`MemoryProvider` seam. Headroom is one provider behind it, not the substrate
under it.**

The contract is deliberately small:

```
search(query, scope, topK) -> results
save(facts, importance, scope) -> ids
describe() -> capabilities   // supersession? scoping? structured reads?
```

Elaboration, in five commitments:

**1. Host-invoked is inherited, and it is what makes the seam composable.**
Providers are called by the host at the same deterministic lifecycle points
ADR-0029 established — session context load, save points, Conductor node
dispatch — never contingent on the model electing to call a tool. Because we
own the call site, the host can fan `search` across N providers and merge, or
write to one provider and mirror to another. Model-invoked tools cannot be
composed deterministically; this is the payoff of ADR-0029's core decision,
generalized one layer up.

**2. `describe()` exists because providers differ in ways the host must not
assume away.** ADR-0029's three constraints are the type specimens, quoted from
that ADR: **C1** — "There is a third state: installed but unprovisioned" —
Headroom's embedder requires `Qdrant/all-MiniLM-L6-v2-onnx` (~86 MB) from
HuggingFace while `mcp_server.main()` sets `HF_HUB_OFFLINE=1`, so the server
"handshakes correctly and advertises both tools while both tool calls return
`isError: true`" (the first-enable fetch is disclosed in docs, not
consent-prompted — owner decision, 2026-08-27). **C2** — "This surface
collapses multi-layer memory to the USER layer": `session_id` / `agent_id` /
`turn_id` are NULL on disk. **C3** — "Reads are prose, not structured":
`memory_search` returns `"1. [relevance=0.50] <content>"`. A provider
*declares* these limits — supersession support, scoping depth, structured
reads, provisioning state — and the host degrades per-provider instead of
assuming capabilities that one engine happens to lack.

**3. First slice ships two providers: `headroom-mcp` and `builtin-markdown`.**
`headroom-mcp` is ADR-0029's surface, unchanged — the seam relocates where its
adapter lives, not what it does. `builtin-markdown` is the default provider:
markdown files with frontmatter, tag- and recency-based lexical retrieval, and
decay/temporal processing (its build-out is SUV-0040). `agentic-memory` is the
third provider, arriving by re-registering an engine Vorno already runs.

**4. `builtin-markdown` is a bounded exception to PLAN-040's first non-goal,
carved here on purpose.** The carve is narrow: markdown files, frontmatter,
lexical retrieval — no embeddings, no vector index, no library ambition, no
public API surface beyond the seam. It is a provider *implementation*, not a
memory *platform*, accepted so the default path has **zero provisioning
burden**: no Python prerequisite, no model fetch, no provider key, no egress —
C1's provisioning problem simply does not exist on the default path. It also
restores ADR-0027 literally: ADR-0029 relocated the file-first alignment to
the *interface* because Headroom's substrate is SQLite; a markdown provider
makes file-first true at the storage layer again *for the default provider*.
Anything beyond that boundary — semantic search, vectors, a queryable platform
— is a different provider's job, reached through the seam.

**5. Two pluggability layers now exist; do not confuse them.** (a) Headroom's
*internal* Python store-backend seam — `ports.py` Protocols plus setuptools
entry points, with the upstream ask "let `LocalBackendConfig` name a store
backend" filed on
[headroomlabs-ai/headroom#3287](https://github.com/headroomlabs-ai/headroom/issues/3287).
That is where SUV-0030/0031 live, unchanged by this ADR. (b) This ADR's
*Vorno-side* provider seam, one layer up. agentic-memory can eventually arrive
by either route; the provider seam is the near-term one and depends on nothing
upstream.

## Consequences

### Positive

- **Engine swap stops being surgery.** Adding or replacing a memory engine
  touches a provider registration, not the Headroom boundary, config schema,
  or settings section.
- **The default path has zero provisioning burden.** `builtin-markdown` needs
  no Python, no model fetch, no key, no egress — memory works out of the box on
  a machine where Headroom was never installed.
- **Composition becomes possible.** Fan-out search and write-mirroring are host
  decisions at an owned call site — unreachable under model-invoked tools.
- **agentic-memory's adherence problem is fixed in passing.** As a provider it
  is host-invoked at defined lifecycle points instead of hoping the model calls
  its tools.
- **The survey's platform-shaped systems get a home.** Engines that do LLM
  extraction on write fit the provider contract exactly, where they could never
  fit a store-level `save() -> id` backend.
- **The rename is free.** Zero SUV-0029 implementation exists to migrate; the
  seam costs nothing more than the adapter would have.

### Negative

- **`builtin-markdown` has no semantic search, stated plainly.** Frontmatter +
  tags + recency is lexical retrieval, not semantic; without embeddings it will
  miss paraphrases a vector index would catch. That is the price of zero
  provisioning, paid only on the default path — semantic search is one provider
  switch away.
- **We now own a small amount of memory code.** The non-goal carve is narrow
  and bounded, but it is a carve: `builtin-markdown` is ours to maintain,
  including its decay and temporal-processing behaviour (SUV-0040).
- **The boundary lint's job grows.** `check-headroom-boundary.ts` must confine
  Headroom specifics to the `headroom-mcp` provider, and the seam itself must
  stay vendor-neutral — a second thing to enforce, not just a second pattern.
- **`describe()` is a vocabulary we must keep honest.** Capability flags that
  drift from provider reality are worse than no flags; each claim needs a test
  against the real provider.
- **Two providers to test in the first slice** where SUV-0029 previously
  scoped one, including the degrade matrix per provider (C1's "installed but
  unprovisioned" state remains a `headroom-mcp` fact the seam must surface, not
  hide).

### Neutral

- ADR-0029's constraints C1/C2/C3 become *per-provider* declarations rather
  than facts about "memory" — the same truths, filed where they belong.
- Out-of-process providers ride the existing MCP-source machinery;
  `builtin-markdown` is statically imported in-tree. Neither adds a loader,
  and any future in-process provider must clear the same bar.
- The seam's `scope` parameter can express more than Headroom's MCP surface
  honours today (C2); `describe()` is what keeps that gap visible rather than
  silently truncated.

## Alternatives considered

- **A — Memory as a Headroom feature** (the status quo plan, SUV-0029 pre-
  re-cut): `memorySearch` / `memorySave` on `HeadroomAdapter` behind
  `HeadroomConfig.enabled`. **Rejected as vendor-shaped.** An engine swap means
  touching the boundary module, the config schema, and the settings surface —
  and "memory off because Headroom off" becomes an architectural fact rather
  than a configuration.
- **B — Each third-party memory system as a Headroom Python entry-point
  backend.** **Rejected on the survey's platform-vs-store finding**: these
  systems do LLM extraction on write, so a store-level `save() -> id` has no
  clean answer for them. This does **not** reject the entry-point route for
  agentic-memory v2 — SUV-0031's track through `ports.py` stands — it rejects
  it as the *general* answer for third-party systems.
- **C — Expose memory tools to the model as ordinary MCP sources.** **Rejected
  as adherence-dependent.** This is what `agentic-memory` does today, and
  ADR-0029's commitment 1 already names the failure mode: memory happens only
  if the model elects to call the tool. It also forecloses composition —
  commitment 1 above depends on the host owning the call site.

## References

- [ADR-0029 — Headroom memory through the memory MCP stdio server, host-invoked from the boundary adapter](0029-headroom-memory-via-host-invoked-mcp.md) (stands unchanged; this ADR generalizes the layer above it)
- [ADR-0027 — Lean on the OS for lifecycle chores](0027-lean-on-the-os-for-lifecycle-chores.md) (file-first bias, restored at the storage layer for the default provider)
- [PLAN-040 — Integrate Headroom](../plans/documented/PLAN-040-integrate-headroom.md) (§I2, the first non-goal this ADR carves against)
- [SUV-0029 — Memory provider seam with Headroom MCP and built-in markdown providers](../suvs/done/SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md) (the first slice; re-cut under this ADR)
- [SUV-0040 — Built-in markdown memory provider with decay and temporal processing](../suvs/done/SUV-0040-builtin-markdown-memory-provider-with-decay-and-temporal-processing.md) (owns the default provider's build-out)
- [SUV-0030 — Memory extension interface designed and proposed upstream](../suvs/done/SUV-0030-memory-extension-interface-designed-and-proposed-upstream.md) (the *other* pluggability layer — Headroom-internal)
- [SUV-0031 — agentic-memory v2 as a plugged backend](../suvs/done/SUV-0031-agentic-memory-v2-as-a-plugged-backend-behind-the-interface.md) (entry-point route; unchanged by this ADR)
- [Headroom memory surface audit](../evidence/PLAN-040/headroom-memory-surface-audit.md) (M1–M7)
- [headroomlabs-ai/headroom#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) — additive upstream gaps, incl. the `LocalBackendConfig` store-backend ask
