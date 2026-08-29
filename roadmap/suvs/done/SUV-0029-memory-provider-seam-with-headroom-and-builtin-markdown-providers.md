---
id: SUV-0029
title: Memory provider seam with Headroom MCP and built-in markdown providers
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-28
related:
  - ADR-0029 (the surface decision that unblocked and re-cut this SUV)
  - ADR-0031 (the provider seam this SUV now ships; generalizes ADR-0029 one layer up)
blocked-by: []
---

# SUV-0029 — Memory provider seam with Headroom MCP and built-in markdown providers

## Goal

Ship the vendor-neutral, **host-invoked** `MemoryProvider` seam of
[ADR-0031](../../decisions/0031-vendor-neutral-memory-provider-seam.md) as the
memory surface for agent sessions and workflow runs, exercised by two real
providers in-tree: `headroom-mcp` (ADR-0029's memory MCP surface, unchanged
underneath) and `builtin-markdown` (a minimal zero-prerequisite default).
Headroom is *a* provider, not *the* substrate.

## Scope

- Define the `MemoryProvider` seam per ADR-0031 —
  `search(query, scope, topK)` / `save(facts, importance, scope)` /
  `describe()` (capabilities: supersession? scoping? structured reads?) — plus
  the registry the host resolves the active provider from. Swapping the active
  provider is a config change; no call site names a provider.
- **Provider 1, `headroom-mcp`:** ADR-0029's surface, unchanged underneath —
  host-invoked MCP calls to Headroom's memory MCP stdio server per
  [ADR-0029](../../decisions/0029-headroom-memory-via-host-invoked-mcp.md),
  supervised as a stdio MCP subprocess
  (`python -m headroom.memory.mcp_server --db <workspace memory.db> --user <id>`)
  reusing Vorno's existing stdio MCP machinery rather than inventing a sidecar
  lifecycle. Its `describe()` declares ADR-0029's C1–C3 limits (unprovisioned
  third state, scoping collapsed to USER, prose reads) so the host degrades
  instead of assuming.
- **Provider 2, `builtin-markdown`:** a *minimal* default provider — markdown
  files + frontmatter, lexical retrieval, no Python, no model fetch, no
  egress. It exists to prove the seam vendor-neutral with N≥2 real
  implementations and to give memory a zero-prerequisite default. **The full
  builtin-markdown build-out — decay, temporal processing, gated loads, logged
  retrieval, PRG trims, archive markers — is NOT this SUV; it is
  [SUV-0040](SUV-0040-builtin-markdown-memory-provider-with-decay-and-temporal-processing.md),
  blocked by this SUV.** This SUV ships the seam and the minimal provider;
  SUV-0040 ships the provider's depth. Read no overlap into the pair.
- Wire session and Conductor workflow construction so the **host** calls
  `search` at context load and `save` at save points and splices results into
  prompts — deterministically, not contingent on the model electing to call a
  tool. Host invocation is also what makes deterministic *composition* possible
  later (fan search across providers and merge; write-one-mirror-another) — the
  seam must not preclude it, but composition itself is out of this slice.
- Detect and represent **three** provider states, not two — absent, present but
  unprovisioned, and ready — surfaced per provider through `describe()`/probing.
  For `headroom-mcp` "unprovisioned" means the embedder model is not cached
  (ADR-0029 C1); `builtin-markdown` never occupies the unprovisioned state,
  which is the point of it being the default.
- Deliberately out: SUV-0040's builtin-markdown build-out (above); multi-provider
  composition (fan/merge, mirrored writes); exposing the memory tools to the
  model as callable tools (a later layered choice); update/delete/supersession/
  history verbs (ADR-0029 commitment 2); the pluggable extension interface
  (SUV-0030); the agentic-memory v2 backend (SUV-0031, unreachable through the
  Headroom surface until `LocalBackendConfig` can carry a store-backend choice —
  audit M7c); and `headroom learn` mining (`wrap`-dependent, out on F3 grounds).
- **In scope, and easy to miss:** extend `scripts/check-headroom-boundary.ts` to
  cover the subprocess seam. It matches package *imports*, so it cannot see
  `python -m headroom.memory.mcp_server` being spawned outside the boundary
  module. Without a second pattern the gate enforces the boundary in one
  direction only, and this SUV is precisely the one that introduces the other.

## Acceptance

- [x] The `MemoryProvider` seam (`search` / `save` / `describe`) is exercised by **two** providers in-tree — `headroom-mcp` and `builtin-markdown` — and swapping the active provider is a config change that touches no call site, asserted by a test that runs the same call path against both.
- [x] The only production reference to Headroom's memory surface remains inside the boundary module — the provider registry/seam is the caller and `headroom-mcp` is one registered provider — with `check-headroom-boundary.ts` extended to catch the **subprocess** seam (`headroom.memory.mcp_server`) as well as package imports, and proven able to go red on a mutation.
- [x] Cross-session retrievability holds per provider: a memory written during one session is retrievable in a later session and in a workflow run, asserted by integration tests against a real `memory.db` for `headroom-mcp` and against real markdown files for `builtin-markdown`.
- [x] Memory is host-invoked: an integration test asserts `search` fires at session context load without the model having requested it.
- [x] Nothing is sent off-machine at steady state, verified against the SUV-0014 telemetry audit's opt-in findings. The one-time ~86 MB embedder model fetch on first **Headroom** enable is the sole documented exception — `headroom-mcp` only; `builtin-markdown` has none — and is named in the docs page (SUV-0032).
- [x] Degrade matrix covered by tests, per provider, via `describe()`/probing: with the active provider **absent**, **present but unprovisioned**, or **disabled**, sessions and workflows run unchanged and memory operations report unavailable rather than throwing — and "unprovisioned" is reported distinctly from "absent" (for `headroom-mcp` the server handshakes and advertises both tools in that state; `builtin-markdown` never occupies it).

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-26` — **`planned/` → `blocked/`. Execution attempted; the SUV's premise
  does not hold, and no implementation was written.**

  PLAN-040 prefixes its capability list with "verify at integration time, not
  from README claims". Doing that first, before shaping any adapter surface,
  established that `headroom-ai@0.36.5` has **no memory API of any kind**: no
  `/v1/memory*` endpoint among the 19 the bundle calls, no `memory` member on
  `HeadroomClient`, no filesystem access at all, and not one occurrence of
  "memory" in its README. Upstream confirms memory is a proxy/CLI feature
  reachable only through `headroom wrap --memory`, the Python client's
  `client.memory.*`, or `memory_save`/`memory_search` tools the proxy injects
  into the model's own tool list. Its substrate is a project-scoped **SQLite**
  database (`.headroom/memory.db`, HNSW + FTS5) — **not** the local markdown this
  SUV's acceptance item 3 requires, and its vector index is a PLAN-040 non-goal.
  `SharedContext`, the one memory-shaped export, is an in-process `Map` with a
  one-hour TTL that dies with the session and fabricates token counts when the
  proxy is unreachable.

  Consequently: acceptance item 1 presupposes memory APIs that do not exist to
  import; item 2 (cross-session, cross-run retrieval) is unachievable without
  building persistence ourselves, PLAN-040's first non-goal; item 3 rests on a
  false premise about Headroom. Only item 4 is satisfiable, and only degenerately
  — "unavailable" would be every path's outcome.

  Deliberately **not** worked around. All four routes forward (adopt the proxy's
  injected model tools; adopt the Python client; read `.headroom/memory.db`
  directly; contribute memory to the TS SDK upstream) are architectural decisions
  above SUV granularity — PLAN-040 open question 1, which §I1 already says to
  record as an ADR. Recommendation is the upstream route, matching the plan's
  upstream-first posture and pairing naturally with SUV-0030. **The owner's call,
  not this SUV's.**

  Landed on `plan/plan-040`, no implementation:
  - `roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md` — findings M1–M5,
    acceptance-by-acceptance impact, the four options, full reproduction steps.
  - `packages/shared/src/headroom/__tests__/sdk-memory-surface.test.ts` — the audit
    as an executable tripwire (6 tests). Reads the package off disk rather than
    importing it, because the boundary gate exempts no file, tests included. On
    the SUV-0014 monthly bump cadence it turns "upstream added memory" from
    something nobody would notice into a red build that says re-open this SUV.
  - PLAN-040's "Memory, multi-layer" bullet corrected in place — it asserted
    "Default substrate: local markdown" as fact — plus a plan status-log entry.
    **SUV-0030 (the plan's priority build item) and SUV-0031 inherit this premise
    and need re-grounding before they are executable.**

- `2026-08-27` — **Second execution attempt. Blocker independently re-verified
  against the installed package; stays `blocked/`; still no implementation.**

  Re-derived from scratch rather than trusting the 08-26 log. `headroom-ai` is
  still pinned at `0.36.5` (`packages/shared/package.json:100`), and its shipped
  `dist/index.d.ts` export list contains exactly three memory-named symbols:
  `MemoryUsage` / `memoryUsage()` (the proxy process's RSS — unrelated), and the
  path helpers `memoryDbPath()` / `nativeMemoryDir()`. There is no `memory`
  member on `HeadroomClient` (`"memory" in client === false` at runtime), and
  the one `retrieve()` method is CCR block-retrieval by content hash, not memory.

  One route the prior audit named but did not close out loud, closed here:
  `nativeMemoryDir()` resolves to `<workspaceDir>/memories` — a *directory*, and
  therefore the last plausible candidate for this SUV's "local markdown"
  substrate. It is a dead path string. Both helpers are pure `joinPath` calls
  (`dist/index.js:253-260`), the identifier appears three times in the whole
  bundle (declaration, export, nothing else), and the package performs no
  filesystem access at all. Neither `~/.headroom/` nor `~/.headroom/memories`
  exists on this machine after the SDK has been exercised. The sibling helper
  names the real substrate: `memory.db`.

  So acceptance item 3's premise is falsified twice over, and the escape hatch —
  writing markdown ourselves — is PLAN-040's first non-goal ("Building our own
  compression, token, or memory library"). Items 1 and 2 remain unimplementable
  for want of an API to import and cross-process persistence to build on. Item 4
  alone is reachable, still only degenerately.

  Also confirmed the 08-26 tripwire is not merely green but *able to go red*:
  each of its five assertion shapes was fed the mutation it exists to catch
  (a `/v1/memory/search` literal, a `readonly memory:` client member,
  `memorySave`/`MemoryStore` after the `MemoryUsage` scrub, a `node:fs` write,
  and a `persistPath` on `SharedContextOptions`) and every one fired. A vacuous
  tripwire would have made "still blocked" unfalsifiable; it isn't.

  Deliberately **not** worked around a second time. Shipping just the adapter
  surface plus "unavailable" would mean designing `MemoryEntry`, provenance, and
  query semantics against an unmade decision — the four routes (proxy-injected
  model tools, Python client, direct `.headroom/memory.db` reads, upstream TS
  contribution) produce four different shapes. That is PLAN-040 open question 1,
  reserved to the owner.

  What SUV-0030's delivery changed: the recommended upstream route is now
  better-grounded, not unblocked. `headroom/memory/ports.py` already defines the
  `MemoryStore` / `VectorIndex` / `TextIndex` Protocols and `factory.py` loads
  backends from setuptools entry points — Python-side seams, with the TypeScript
  gap filed upstream as headroomlabs-ai/headroom#3287.

  **Unblocking act is an ADR choosing the memory surface. After that this SUV
  needs re-cutting, not executing: acceptance item 3's markdown requirement has
  to go, and items 1–2 re-grounded on whichever surface the ADR picks.**

  Landed on `plan/plan-040`: this status-log entry only. No source file was
  created, edited, moved, or deleted.

- `2026-08-27` — **Third execution attempt. Blocker re-derived from the *running*
  Headroom, not the npm bundle; stays `blocked/`; still no implementation. One
  factual error in the entry above is corrected.**

  The two prior attempts both reasoned from `node_modules/headroom-ai/dist` and
  from upstream's wiki. This one went to the artefact. Re-confirmed the bundle
  facts first-hand — `dist/index.d.ts`'s export list carries exactly
  `MemoryUsage` / `memoryUsage()` (proxy RSS) and the path helpers
  `memoryDbPath()` / `nativeMemoryDir()`; the sixteen `/v1/*` literals in
  `dist/chunk-2NXG6XPP.js` are chat/compress/feedback/messages/retrieve/telemetry/
  toin, with **no `/v1/memory*`**; `grep -ci memory README.md` → `0` — and then
  found what neither prior pass looked for.

  **A Headroom CLI is installed on this machine**, `~/.local/bin/headroom`,
  version **0.36.5** — the same version as the npm pin, so this is the matched
  Python half of the product, not version skew. `headroom memory` is real, and
  running it initialises `~/.headroom/memory.db`. `sqlite3 … ".tables"` → a
  single `memories` table whose columns are precisely the multi-layer scoping
  (`user_id`/`session_id`/`agent_id`/`turn_id`), temporal validity, supersession
  lineage and `entity_refs`/`metadata` provenance this SUV's scope line asks
  for — alongside an `embedding BLOB`. `headroom memory stats` reports over
  **USER / SESSION / AGENT / TURN**. The feature exists; it is just not
  addressable from our TypeScript.

  **Correction to the 08-27 entry above.** It asserted "Neither `~/.headroom/`
  nor `~/.headroom/memories` exists on this machine." The first half is **wrong**
  — `~/.headroom/` exists and is populated (`config/`, `logs/`, `ccr_store.db`,
  `savings_events.jsonl`, `subscription_state.json`). Only
  `~/.headroom/memories` is absent, and that was always the load-bearing half, so
  the conclusion stands while its stated evidence did not. Repaired in the audit
  as **M6**, which also flags that the audit's "HNSW + FTS5" came from upstream's
  wiki and is *not* observable in a fresh database — `sqlite_master` holds only
  `memories` and its twelve indexes, no FTS5 virtual table. Recorded as
  documented-but-unreproduced rather than quietly restated as fact.

  **Why this sharpens the decision instead of unblocking it.** `headroom memory`
  exposes `list`/`show`/`stats`/`edit`/`delete`/`prune`/`purge`/`reindex`/
  `export`/`import`/`repair-supersession` — and **no `add`, no `search`**. It is
  an administration surface over the store, not the write/query surface an
  integration needs; the only CLI write is whole-file `import`. Real memory
  creation still happens exactly where the audit's M2 said: proxy-injected
  `memory_save` in the model's own tool list, or the Python client. So the routes
  forward are unchanged in number and now better evidenced — and every one of
  them lands on **SQLite**, observed directly this time, which is what acceptance
  item 3 forbids. Items 1–2 remain unimplementable for want of a TypeScript API
  to import and cross-process persistence to build on; item 4 alone is reachable,
  still only degenerately.

  Not worked around a third time, for the same reason and now with a third
  independent falsification of item 3's premise. Building the markdown substrate
  ourselves is PLAN-040's first non-goal; choosing among the routes is PLAN-040
  open question 1, reserved to the owner.

  **Unblocking act is unchanged: an ADR choosing the memory surface. After it,
  this SUV needs re-cutting rather than executing — item 3's markdown requirement
  has to go, and items 1–2 be re-grounded on whichever surface the ADR picks.**

  Landed on `plan/plan-040`: audit finding **M6** plus its reproduction block in
  `roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md`, and this entry.
  No source file was created, edited, moved, or deleted; the four acceptance
  boxes remain unchecked because none of them is met.

- `2026-08-27` — **UNBLOCKED and re-cut. `blocked/` → `planned/`.** The
  unblocking act named by all three prior entries has happened:
  [ADR-0029](../../decisions/0029-headroom-memory-via-host-invoked-mcp.md)
  chooses the memory surface.

  **The chosen surface is a fifth option none of the three audit passes found**,
  and the reason they missed it is worth recording, because it is a repeatable
  research failure: every pass reasoned about the **npm bundle** and upstream's
  **wiki**. None opened the installed **Python package**.
  `headroom/memory/mcp_server.py` ships in the pinned 0.36.5 — a stdio MCP
  server exposing `memory_search` and `memory_save` — and upstream's own
  `headroom wrap` writes exactly its invocation into generated MCP config
  (`cli/wrap.py:3064-3066`), so it is a shipped, exercised entry point.

  Verified by driving it over real stdio JSON-RPC rather than reading it:
  `initialize` → `serverInfo {"name":"headroom-memory","version":"1.29.1"}` →
  `tools/list` → `['memory_search','memory_save']` → saved two facts → searched
  and got both back ranked (`relevance=0.50`, `0.16`). **PLAN-040's first
  working memory round-trip.** It launches as
  `python -m headroom.memory.mcp_server`, with **no `headroom wrap` in the
  path** — which is what makes the F3 posture structural rather than argued.

  **Acceptance rewritten, not merely unblocked.** Old item 3's "local markdown"
  requirement is **struck** — the substrate is SQLite, and ADR-0029 accepts that
  by relocating the ADR-0027 alignment to the *interface* (behaviour tunable in
  settings) rather than the storage engine. Items 1–2 are re-grounded on the MCP
  surface. Old item 4's degrade arm was degenerate ("unavailable" was every
  path's outcome); it is now non-degenerate and, per the finding below, has
  **three** states to cover rather than two.

  **Three constraints this surface imposes, all discovered during the same
  verification and all now load-bearing on the acceptance list:**
  - **Installed ≠ working.** The embedder is hardwired to ONNX and needs
    `Qdrant/all-MiniLM-L6-v2-onnx` (~86 MB) from HuggingFace, while
    `mcp_server.main()` sets `HF_HUB_OFFLINE=1` via `setdefault`. On this
    machine — CLI installed, `~/.headroom/` populated — the model was **not**
    cached, and both tools returned `isError: true` while the server handshook
    correctly and advertised both. Re-running with `HF_HUB_OFFLINE=0` fetched it
    and everything passed. Hence the third state in scope and acceptance.
  - **Four-layer scoping collapses to USER.** `_handle_save` passes only
    `content`/`user_id`/`importance`; `session_id`, `agent_id`, `turn_id` are
    **NULL** on disk, confirmed by querying the rows this test wrote. Upstream
    advertises USER → SESSION → AGENT → TURN as a differentiator; this surface
    does not expose it.
  - **Reads are prose.** `memory_search` returns
    `"1. [relevance=0.50] <content>"`, not structured JSON — so the original
    scope line's "provenance-carrying reads" degrades to a formatted string.

  The latter two are filed as additional gaps on
  [#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) alongside the
  LocalBackend-bypass gap, for the 2026-09-03 bump.

  **The SUV-0014 tripwire keeps its teeth and changes meaning.** A memory API
  appearing in the TS SDK still turns the monthly bump red — but it is now an
  *upgrade* signal (migrate off MCP toward ADR-0029's preferred end state)
  rather than an *unblock* signal.

  Landed on `plan/plan-040`: this entry, the frontmatter and scope/acceptance
  re-cut, the folder move, and audit finding **M7**. No implementation yet —
  that is this SUV's next execution, now genuinely executable.

- `2026-08-27` — **Follow-up pass: two errors in the entry above corrected, both
  found by an independent read of the same code.**

  **(a) "Bypasses `factory.py`" was wrong, and the wrong version implies the
  wrong upstream ask.** The MCP server does not bypass the factory —
  `core.py:124` calls `create_memory_system(config)`. The real constraint is that
  `LocalBackendConfig` has **no `store_backend` field**, so the `MemoryConfig`
  built at `backends/local.py:186-195` keeps the `StoreBackend.SQLITE` default
  and `factory.py:128` always takes the SQLite branch. The `EXTERNAL` branch is
  live and unreachable, not absent. Filing "route it through the factory" would
  have been rejected as already done; the correct ask is "let
  `LocalBackendConfig` and the MCP server name a store backend". Caught **before**
  it reached #3287. Full trace in audit **M7c**.

  **(b) Audit §M2 carried a false claim that helped keep this SUV blocked for
  three passes.** It stated "there is **no MCP memory tool** — Headroom's MCP
  server offers `headroom_compress`, `headroom_retrieve`, `headroom_stats` only."
  That is true of the *compression* MCP server and was generalised to "the MCP
  server" as though there were only one. Since M2 was the finding that ruled MCP
  out as a surface, the error was load-bearing: the answer sat inside the pinned
  package the whole time. Repaired in the audit with the original text preserved.

  Also recorded: audit **M7d** (four sharp edges — `memory_save` declares
  `"required": []`, an undeclared `content` compat path, a `superseded` counter
  that is structurally always zero so dedup is the host's problem, and `category`
  written as `''`), and **M7e** (HNSW stays *documented*, not reproduced —
  M7a closed only the FTS5 half of M6's caveat).

  Scope and acceptance amended: extending `check-headroom-boundary.ts` to the
  subprocess seam is now explicit, because the gate matches package imports and
  this SUV is the one that introduces a non-import path to Headroom.

- `2026-08-28` — **Re-cut in place: `planned/` stays; title, scope and acceptance
  re-grounded on [ADR-0031](../../decisions/0031-vendor-neutral-memory-provider-seam.md)'s
  vendor-neutral `MemoryProvider` seam. Headroom is demoted from substrate to
  provider.**

  ADR-0029 stands untouched — the memory MCP stdio server, host-invoked, with
  constraints C1–C3 exactly as recorded. What changes is one layer up: instead
  of bolting `memorySearch`/`memorySave` onto `HeadroomAdapter` behind
  `HeadroomConfig.enabled` — vendor-shaped, memory as a feature of Headroom — the host
  calls a `MemoryProvider` seam (`search`/`save`/`describe`) and `headroom-mcp`
  is one registered provider. `describe()` is where C1–C3 stop being
  assumptions baked into call sites: a provider declares its
  supersession/scoping/structured-read limits and the host degrades instead of
  hardcoding Headroom's shape. And host invocation — the core of ADR-0029's
  decision — generalizes into what makes deterministic *composition* possible
  at all (fan a search across providers and merge; write to one, mirror to
  another); composition itself stays out of this slice, but the seam must not
  preclude it.

  **Why the re-cut is free right now: this SUV has zero implementation.** Its
  own log proves it — three blocked passes produced audits and a tripwire test
  about the *SDK*, and each closed with "no source file was created, edited,
  moved, or deleted". Renaming the seam before writing it costs exactly this
  docs diff; renaming it after would be a migration through the shipped
  settings surface (SUV-0016/0017) and the boundary lint.

  **The recorded tension with PLAN-040's first non-goal, resolved rather than
  waved off.** The 08-26 and 08-27 entries invoked "no memory library of ours"
  against writing markdown ourselves — rightly, against what was then on the
  table: building the persistence a Headroom acceptance item had falsely
  promised. ADR-0031 carves a deliberate, bounded exception instead:
  `builtin-markdown` is a default *provider* — markdown + frontmatter, lexical
  retrieval only, no embeddings, no vector index, no Python, no egress — not a
  memory platform, and its honest cost (lexical, not semantic, search) is
  stated in scope rather than hidden. It exists to prove the seam
  vendor-neutral with N≥2 real implementations and to give memory a
  zero-prerequisite default. Its full build-out (decay, temporal processing,
  gated loads, logged retrieval, PRG trims, archive markers) is deliberately
  split out as SUV-0040, blocked by this SUV, so the two cannot be read as
  overlapping: this SUV ships the seam plus the minimal provider; SUV-0040
  ships the provider's depth.

  File renamed
  `SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md` →
  `SUV-0029-memory-provider-seam-with-headroom-and-builtin-markdown-providers.md`
  (`git mv`); inbound filename references updated in SUV-0032 (two lines),
  SUV-0033 (one line), and the stale title strings in
  `roadmap/suvs/definitions/SUV-0029.task.yaml`. The id is unchanged, so id
  references needed nothing; the task definition's prompts resolve this file by
  glob `SUV-0029-*.md` and survive the rename.

  Landed on `plan/plan-040`: this entry, the rename, and the
  frontmatter/goal/scope/acceptance rewrite. No source files.

- `2026-08-28` — **EXECUTED. `planned/` → `done/`. All six acceptance items met;
  this is the first implementation this SUV has ever had.** Four prior passes
  produced audits, a tripwire, an ADR, and a re-cut, each closing "no source
  file was created, edited, moved, or deleted". That streak ends here.

  **The seam.** `packages/core/src/types/memory-provider.ts` defines
  `MemoryProvider` = `search` / `save` / `describe`, plus `MemoryResult<T>`
  (measured-or-absent), `MemoryProviderCapabilities`, and a **five**-value
  `MemoryUnavailableReason` whose whole point is that `provider-absent` and
  `provider-unprovisioned` stay distinguishable. Four invariants are inherited
  verbatim from `headroom-adapter.ts` because they are what made that boundary
  hold: import-free plain data, measured-or-absent, non-throwing by contract,
  and — new here — capabilities declared rather than assumed.
  `packages/core/src/types/memory.ts` is the config, a deliberate **sibling** of
  `headroom.ts` rather than a section inside it; if it were nested, "memory off
  because Headroom off" would be an architectural fact instead of a setting.

  **Two providers, in tree.** `builtin-markdown` (markdown + frontmatter,
  lexical retrieval, `node:fs` and nothing else) and `headroom-mcp` (ADR-0029's
  stdio surface, unchanged underneath, riding the existing `CraftMcpClient`
  rather than a new sidecar lifecycle). `registry.ts` is a `switch` and both
  imports are static — ADR-0031 commitment 5's "no plugin system, and this ADR
  does not invent one", honoured literally.

  **Host-invoked, at a call site we own.** `BaseAgent` resolves config
  synchronously at construction (the Headroom rule, same reason), then
  `chat()` calls `loadSessionMemoryContext` before the message parts are joined
  and `saveSessionMemory` in the `finally`. With memory off, `loadMemoryContext`
  returns `null` and the joined prompt is **byte-identical** to what it was
  before this feature existed — asserted, not asserted-to.

  **The boundary gate now holds in both directions.** `check-headroom-boundary.ts`
  gained `findMemorySubprocessViolations` / `findStaleMemoryBoundaryEntries` and
  a second allowlist of exactly one file. The new pattern matches the module
  path **both** written whole and assembled from parts, because a gate that
  catches only the literal teaches the next author to build it from pieces. It
  was proven able to go red the honest way: it caught its own test file twice
  during authoring — once on an array literal, once on a prose mention — since
  it exempts neither comments nor tests.

  **Three defects the tests found, all fixed, all worth recording:**
  - **`resolveHeadroomPython` treated an explicit path as a first guess**, not
    as authoritative — so a caller naming an interpreter could silently get a
    different one. A user's `VORNO_HEADROOM_PYTHON` would have been honoured
    only when it happened to work.
  - **The Headroom server resolved its database from the current working
    directory** (`config_source=cwd-default`, observed live). For a desktop app
    that means memory lands in a different store depending on how the app was
    launched, and scatters `.headroom/` into unrelated folders — it wrote one
    into `packages/shared/` during the first test run. Now pinned with `--db`
    to `<workspace>/memory/headroom-memory.db`, alongside the built-in store, so
    "where are my memories" has one answer.
  - **`describe()` reported every failing probe as `unprovisioned`.** The real
    error was `unable to open database file`, which is not an embedder problem
    and would have told the user to download 86 MB that could not help. Now
    classified by `looksLikeMissingEmbedder`, conservatively: an unrecognised
    error is `absent` with the server's own message attached, never optimistically
    "just needs a download".

  Landed on `plan/plan-040`: `packages/core/src/types/memory{,-provider}.ts`;
  `packages/shared/src/memory/` (registry, two providers, unavailable provider,
  store, file format, decay, lexical, session-memory) with 135 tests;
  `workspaces/memory.ts` + config/instance layers with 104 mirrored tests;
  the RPC channel, settings validation, and workspace settings section with
  capabilities surfaced (including the honest `notes`); i18n for 7 locales;
  `apps/electron/resources/docs/memory.md`; and the gate extension.
  **SUV-0040 is unblocked and shipped in the same pass — see its own log.**
