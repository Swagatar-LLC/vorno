---
title: Headroom memory surface — integration-time verification
plan: PLAN-040
suv: SUV-0029
direction: DIR-05
author: jh
created: 2026-08-26
subject: headroom-ai@0.36.5
verdict: blocked-premise-not-met
---

# Headroom memory surface — integration-time verification

**Subject:** `headroom-ai@0.36.5` (the version pinned by SUV-0014)
**Date of audit:** 2026-08-26
**Question:** can SUV-0029 be built — can Vorno put Headroom's multi-layer
memory behind the `HeadroomAdapter` boundary, as a persistent, local-markdown
substrate shared by agent sessions and Conductor workflow runs?

> **Verdict: no, not through the pinned SDK, and not through any surface Vorno
> has adopted.** The memory feature is real, but it is not in this package and
> is not reachable from TypeScript. Two of SUV-0029's four acceptance items are
> unachievable as written; a third presupposes an API that does not exist.
> Proceeding would require either an architectural decision Vorno has not made
> (which Headroom surface provides memory) or building memory persistence
> ourselves — the latter explicitly forbidden by PLAN-040's non-goals.

PLAN-040 introduces its capability list with the instruction this report is
answering:

> "## What Headroom provides (**verify at integration time, not from README
> claims**)"

This is that verification. The result is negative, and the negative is the
deliverable.

---

## 1. What the plan and SUV assumed

PLAN-040 §"What Headroom provides":

> "**Memory, multi-layer:** cross-agent shared store (Claude/Codex/Gemini/Grok,
> auto-dedup, provenance) + `headroom learn` (mines failed sessions, writes
> corrections to agent context files). **Default substrate: local markdown** —
> philosophically aligned with our file-first, human-readable bias (ADR-0027)."

SUV-0029 turned that into scope ("backed by Headroom's memory layers with its
default local-markdown substrate") and into acceptance items requiring
cross-session persistence and an on-disk markdown substrate.

**The "local markdown" clause is the load-bearing error.** It is not what
Headroom does.

---

## 2. Findings

### M1 — The pinned TypeScript SDK has no memory API at all

Not a thin one; none. Verified against the exact pinned bytes.

The complete endpoint inventory in `dist/` (every SDK method is an HTTP call on
a relative path against `baseUrl`, per SUV-0014 §3.2):

```
/v1/compress            /v1/retrieve            /v1/retrieve/stats
/v1/retrieve/tool_call  /v1/chat/completions    /v1/messages
/health                 /stats                  /stats-history
/metrics                /debug/memory           /cache/clear
/v1/telemetry           /v1/telemetry/export    /v1/telemetry/import
/v1/telemetry/tools     /v1/feedback            /v1/toin/stats
/v1/toin/patterns
```

**There is no `/v1/memory*` endpoint.** `/debug/memory` is the proxy process's
own RAM usage (`MemoryUsage.processMemory`), unrelated to the memory feature.

The package's own `README.md` — 10.2 KB — contains **zero** occurrences of
"memory", "remember", "recall", or "persist".

### M2 — Memory is a proxy/CLI feature, reachable only from Python or the wrapper

Upstream's memory documentation
([`wiki/memory.md`](https://github.com/headroomlabs-ai/headroom/blob/main/wiki/memory.md))
describes three access paths, none of them this package:

1. **CLI wrapping** — `headroom wrap claude --memory` routes an agent through
   the proxy with memory enabled.
2. **Python client** — `with_memory()`, then `client.memory.search()`,
   `client.memory.add()`.
3. **Proxy-injected model tools** — the proxy injects
   `memory_save` / `memory_search` / `memory_update` / `memory_delete` as native
   provider tools (Anthropic `tool_use`, OpenAI functions) into the completion
   request.

Memory is **not exposed over HTTP** on the proxy.

> **CORRECTED 2026-08-27 — see [M7](#m7--a-memory-mcp-stdio-server-ships-in-the-pinned-version-and-it-works).**
> This paragraph originally continued: "and there is **no MCP memory tool** —
> Headroom's MCP server offers `headroom_compress`, `headroom_retrieve`,
> `headroom_stats` only. So neither of PLAN-040's two named fallback surfaces
> (proxy, MCP) carries memory either." **That is false.** It is true of the
> *compression* MCP server and was generalised to "the MCP server" as though
> there were only one. There is a second: `headroom.memory.mcp_server`, shipping
> in this same pinned version, exposing `memory_search` and `memory_save`. The
> proxy half of the claim stands; the MCP half was the error that kept SUV-0029
> blocked across three passes, and it propagated into PLAN-040's corrected
> capability bullet and SUV-0029's `blocked-by` line — both repaired.

This is a sharper form of SUV-0014's **F4** ("this SDK is a proxy client, not an
in-process library"). F4 established that adopting the SDK entails running the
proxy. M2 establishes that even *with* the proxy running, memory is not
addressable from Vorno's TypeScript.

### M3 — The substrate is SQLite with a vector index, not local markdown

Upstream documents the store as:

> "Project-scoped database at `{cwd}/.headroom/memory.db`" — "`.headroom/memory.db`
> (project-scoped SQLite)"

with an **HNSW vector index** and an **FTS5** full-text index over an embeddings
table. The SDK's own path helper agrees: `memoryDbPath()` returns
`<workspace>/memory.db`.

Three consequences:

- SUV-0029's acceptance item 3 ("the memory substrate on disk is local markdown,
  human-readable") is **false of Headroom**, not merely unimplemented. A SQLite
  file with an HNSW index is not human-readable markdown.
- The ADR-0027 "file-first, human-readable" alignment that motivated this part of
  the plan **does not hold**. That was the stated reason for preferring
  Headroom's memory; it should be re-examined, not assumed.
- An HNSW vector index over embeddings is vector-database infrastructure, which
  PLAN-040 lists as an explicit **non-goal**. Adopting this substrate adopts that
  too — worth a deliberate decision rather than arriving as a side effect.

### M4 — `SharedContext` is a process-local cache and cannot stand in

`SharedContext` is the only memory-shaped export in the SDK, and it is the most
likely thing to be mistaken for the memory layer. It is not one. From the pinned
`dist/index.js`:

```js
var SharedContext = class {
  entries = /* @__PURE__ */ new Map();
  ...
  this.ttl = ttl ?? 3600;
  this.maxEntries = maxEntries ?? 100;
```

An in-process `Map`, declared `private` in the types, with a one-hour TTL and a
100-entry cap. It is not written to disk, is not visible to another process, and
does not survive the session that created it. It satisfies neither half of
acceptance item 2 (cross-session, cross-run retrieval).

Two further reasons it is unfit as a substrate even for a single session:

- **It fabricates token counts on failure.** When `compress()` throws — the
  expected state whenever no proxy is listening — `put()` stores
  `tokensBefore: content.length / 4` with the comment `// rough estimate`. Those
  are exactly the interpolated numbers PLAN-040 forbids and SUV-0015's
  `HeadroomMeasurement` type exists to keep off a token surface.
- **It stores the *compressed* form and returns it by default.** `get(key)`
  yields compressed content unless `full: true`; a memory layer that silently
  hands back lossily-compressed text is a different product from the one the
  plan describes.

### M5 — The package cannot persist anything: it makes no filesystem calls

Independently confirming M1/M3/M4, and re-confirming SUV-0014 §3.4: there are
**no** `readFileSync`, `writeFileSync`, `mkdirSync`, `appendFileSync`,
`createWriteStream`, `node:fs` imports or `require("fs")` calls anywhere in
`dist/`. The SDK's own paths module states it outright:

> "The TypeScript SDK is an HTTP client today and does not touch the filesystem
> directly. This module mirrors `headroom/paths.py` so that future local
> features ... land on the same contract."

`memoryDbPath()` and `nativeMemoryDir()` compute **path strings** for the Python
side's benefit. Nothing in the package reads or writes them.

### M6 — The memory store is real and present on this machine; observed directly, and it is SQLite

*Added 2026-08-27, third execution attempt. M1–M5 were derived from the shipped
bundle and from upstream's documentation. M6 is the same conclusion reached from
the running artefact instead, which makes M2/M3 first-hand rather than cited —
and corrects a factual error the previous attempt put in SUV-0029's status log.*

A Headroom **CLI is installed on this machine** at `~/.local/bin/headroom`,
reporting `headroom, version 0.36.5` — the same version as the pinned
`headroom-ai` npm package, so the two surfaces are a matched pair, not a
version-skew artefact. Its top-level help advertises memory as a headline
feature ("Manage memories, run the optimization proxy, and analyze metrics"),
and `headroom memory --help` lists thirteen subcommands.

**Correction.** The 2026-08-27 status-log entry on SUV-0029 stated: *"Neither
`~/.headroom/` nor `~/.headroom/memories` exists on this machine after the SDK
has been exercised."* The first half of that is **wrong**. `~/.headroom/`
exists and is populated (`config/`, `logs/`, `ccr_store.db`,
`savings_events.jsonl`, `subscription_state.json`, …). Only
`~/.headroom/memories` — the `nativeMemoryDir()` path — is absent, which is the
part that actually carried the argument. The conclusion survives the
correction; the stated evidence for it did not, and is repaired here.

What the live store shows:

- `headroom memory stats` renders a table over **four scopes — USER, SESSION,
  AGENT, TURN**. That hierarchy is the "multi-layer" in this SUV's title, and it
  is real, not a README claim.
- Running any memory command **initialises `~/.headroom/memory.db`** (56 KB,
  zero rows here). `sqlite3 ~/.headroom/memory.db ".tables"` → `memories`. The
  substrate is **SQLite**, observed, not inferred — **M3 confirmed from the
  artefact**, and acceptance item 3's "local markdown" is false a third
  independent way.
- The `memories` schema carries the provenance and lineage columns this SUV's
  scope line asks for (`user_id` / `session_id` / `agent_id` / `turn_id`,
  `created_at` / `valid_from` / `valid_until`, `supersedes` / `superseded_by` /
  `promoted_from` / `promotion_chain`, `access_count`, `entity_refs`,
  `metadata`) plus an **`embedding BLOB`** column and twelve indexes.
- **Precision note against M3:** in a freshly-initialised database
  `sqlite_master` holds exactly one table (`memories`) and its indexes — **no
  FTS5 virtual table and no HNSW index table are present yet**. M3 sourced both
  from upstream's wiki. The `embedding BLOB` column is direct evidence that
  vector search is the design; the two index structures are not observable until
  the store has been written to, so treat "HNSW + FTS5" as documented-but-not-yet-
  reproduced rather than as observed fact.

**The finding that matters for the ADR:** `headroom memory` has `list`, `show`,
`stats`, `edit`, `delete`, `prune`, `purge`, `reindex`, `export`, `import`,
`repair-supersession` — and **no `add` and no `search`**. The CLI is an
*administration* surface over the store, not the write/query surface an
integration needs. Reads are available (`list` / `show` / `export`); the only
CLI write path is `import` of a whole JSON file. Ordinary memory creation
happens where M2 said it does — the proxy injecting `memory_save` into the
model's tool list, or the Python client's `client.memory.add()`.

So this does not unblock the SUV; it sharpens the decision. A Vorno-side
integration over this surface would mean shelling out to a Python CLI per
operation, with writes going through whole-file `import`, or standing up the
proxy and depending on model-side tool calls. Both are architectural
commitments well above SUV granularity, and both still land on the SQLite
substrate that acceptance item 3 forbids. That is PLAN-040 open question 1.

---

### M7 — A memory MCP stdio server ships in the pinned version, and it works

**This finding supersedes the audit's central negative conclusion, and corrects
M6 on one point.** Findings M1–M6 are accurate as far as they looked. They did
not look far enough: every pass reasoned about the **npm bundle**
(`node_modules/headroom-ai/dist`) and upstream's **wiki**. None opened the
installed **Python package**. That is where the memory surface was.

`headroom/memory/mcp_server.py` ships **in the pinned 0.36.5** — the same
version as the npm pin, so this is the matched Python half of the product, not
version skew. It is a stdio MCP server whose module docstring reads: "A stdio
MCP server that exposes headroom's memory backend as tools —
`memory_search` (semantic search across stored memories), `memory_save`
(persist a new fact/decision/convention)."

It is not an internal detail. Upstream's own `headroom wrap` writes exactly this
invocation into its generated MCP config
(`cli/wrap.py:3064-3066`: `args = ["-m", "headroom.memory.mcp_server", "--user", "{user_id}"]`),
so it is a shipped, exercised entry point — and it is reachable **without**
`wrap`, which is what makes it viable under F3.

**Driven end-to-end over real stdio JSON-RPC**, not read:

```
initialize  -> serverInfo {"name":"headroom-memory","version":"1.29.1"}
tools/list  -> ['memory_search', 'memory_save']
memory_save -> Saved 2 new, updated 0 existing (2 total)
memory_search("what version of headroom is pinned?")
            -> 1. [relevance=0.50] Vorno pins headroom-ai at 0.36.5.
               2. [relevance=0.16] PLAN-040 chose the memory MCP stdio surface.
```

**This is PLAN-040's first working memory round-trip.** M1–M6 established what
does not exist; M7 establishes what does. The surface decision it enabled is
[ADR-0029](../../decisions/0029-headroom-memory-via-host-invoked-mcp.md).

#### M7a — Correction to M6: FTS5 is real and now reproduced

M6 recorded FTS5 as "documented but unreproduced", because `sqlite_master` on a
freshly initialised database held only `memories` and its indexes. **That was an
artifact of inspecting an empty store.** After real writes through the MCP
server, `sqlite_master` carries `memory_fts`, `memory_fts_data`,
`memory_fts_idx`, `memory_fts_content`, `memory_fts_docsize`, and
`memory_fts_config`. The FTS5 index is created lazily on first write. M6's
caution was correct practice and its conclusion was wrong; recording both.

#### M7b — Three constraints the surface imposes

1. **Installed ≠ working — there is a third state.** The embedder is hardwired
   (`LocalBackendConfig(db_path=..., embedder_backend="onnx")`,
   `mcp_server.py:170-171`) and requires `Qdrant/all-MiniLM-L6-v2-onnx`
   (~86 MB, `adapters/embedders.py:432`) from HuggingFace Hub — while
   `mcp_server.main()` sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` via
   `setdefault`. On this machine, with the CLI installed and `~/.headroom/`
   populated, the model was **not** cached, and the result was:
   **the server handshakes correctly and advertises both tools while both tool
   calls fail** with `isError: true` — "An error happened while trying to locate
   the file on the Hub and we cannot find the requested files in the local
   cache." Re-running with `HF_HUB_OFFLINE=0` fetched the model and every call
   passed. `setdefault` means the environment can override it. Consumers must
   therefore distinguish **absent**, **present-but-unprovisioned**, and **ready**.
2. **Four-layer scoping collapses to USER.** `_handle_save` passes only
   `content` / `user_id` / `importance` to `backend.save_memory`. Confirmed by
   querying the rows this test wrote: `session_id`, `agent_id`, and `turn_id`
   are **NULL**. Upstream advertises USER → SESSION → AGENT → TURN hierarchical
   scoping as a differentiator against Letta and Mem0; this surface does not
   expose it.
3. **Reads are prose, not structured.** `_handle_search` formats results as
   `"1. [relevance=0.50] <content>"` with an optional `Related:` line. There is
   no structured `entity_refs` / `metadata` in the response.

Constraints 2 and 3, plus the `LocalBackend` bypass below, are filed as
additional gaps on
[#3287](https://github.com/headroomlabs-ai/headroom/issues/3287).

#### M7c — The MCP server cannot reach a pluggable backend, but not because it bypasses the factory

**This finding was stated imprecisely on first writing and is corrected here
before it reached upstream**, because the imprecise version implies the wrong
fix. The original text said the MCP server "bypasses `factory.py`'s setuptools
`EXTERNAL` entry-point routing". It does not bypass the factory at all.

The actual chain, traced end to end:

1. `mcp_server.py:170-171` → `LocalBackend(LocalBackendConfig(db_path=..., embedder_backend="onnx"))`
2. `backends/local.py:186-195` builds a `MemoryConfig` passing `db_path`,
   `embedder_*`, `vector_dimension`, and `cache_*` — and **never
   `store_backend`**, because `LocalBackendConfig` (`backends/local.py:37-66`)
   **has no such field**.
3. `MemoryConfig.store_backend` therefore keeps its default,
   `StoreBackend.SQLITE` (`config.py:99`).
4. `core.py:124` calls `create_memory_system(config)` — **the factory is
   reached** — and `factory.py:128` takes the `SQLITE` branch every time. The
   `EXTERNAL` branch at `factory.py:133` is live and correct; it is simply
   unreachable from this path.

So the seam SUV-0030 designed against and SUV-0031 plugged agentic-memory v2
into is intact. What is missing is any way to *express* a non-SQLite choice
through the local backend: `LocalBackendConfig` needs `store_backend` /
`store_backend_name` fields to pass through, and `mcp_server.py`'s argparse
needs flags to set them.

**The upstream ask is therefore "let `LocalBackendConfig` and the memory MCP
server name a store backend", not "route the MCP server through the factory".**
Filing the latter would have been rejected as already done, and would have read
as not having looked. This remains the gating dependency for SUV-0031's value
being realised through the chosen surface.

#### M7d — Four further sharp edges in the MCP surface

Found while tracing M7c; none blocking, all worth knowing before writing against
this surface:

- **`memory_save` declares `"required": []`.** A no-argument call is
  schema-valid. The handler returns "Error: facts array is required" as ordinary
  non-error text, so a host that only checks `isError` will read a silent no-op
  as success.
- **An undeclared `content: string` compat path** exists
  (`mcp_server.py:338-342`): if `facts` is absent, a bare `content` string is
  accepted. Not in the advertised schema.
- **The `superseded` counter is structurally always zero.** It is initialised to
  0 and never incremented (`:348-368`), so "Saved N new, updated M existing"
  always reports `M = 0`. Deduplication is entirely the host's problem — which
  matches the tool description's own warning that supersession requires an
  explicit update path with a memory ID, a path this surface does not expose.
- **`category` is written as `''`, not NULL** (the column is `NOT NULL`) — a
  fifth field the MCP surface cannot populate, alongside the three scope columns
  in M7b.

#### M7e — HNSW remains documented, not reproduced

M7a closed M6's FTS5 caveat. **It does not close the HNSW half, and that half
should not be quietly restated as fact.** After real writes, no HNSW structure
appears; `config.py:104` defaults `vector_backend` to `VectorBackend.AUTO`,
documented as "SQLITE_VEC if available, else HNSW", so which index is actually
in play is environment-dependent and was not determined here. Everywhere this
corpus says "SQLite + HNSW + FTS5", read it as: SQLite observed, FTS5 observed,
HNSW documented and unverified.

#### M7 reproduction

Requires the matched CLI (`~/.local/bin/headroom` → 0.36.5). Writes only to the
throwaway database passed via `--db`.

```bash
# The server, launchable with no `headroom wrap` in the path:
python -m headroom.memory.mcp_server --db /tmp/smoke/memory.db --user smoke

# Drive it over stdio with initialize -> notifications/initialized ->
# tools/list -> tools/call. Unprovisioned machines fail here:
#   both tools -> isError: true, "cannot find the requested files in the local cache"
# Provision the embedder once, then both calls succeed:
HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python -m headroom.memory.mcp_server ...

# Scoping collapse and the lazily-created FTS5 index, after writes:
sqlite3 /tmp/smoke/memory.db \
  "select id,user_id,session_id,agent_id,turn_id from memories;"   # -> scopes NULL
sqlite3 /tmp/smoke/memory.db \
  "select name from sqlite_master where type='table';"             # -> memory_fts* present
ls ~/.cache/huggingface/hub | grep -i minilm   # -> models--Qdrant--all-MiniLM-L6-v2-onnx
```

## 3. Impact on SUV-0029's acceptance list

| # | Acceptance item | Status |
|---|---|---|
| 1 | Boundary adapter exposes memory operations; only production import of Headroom's **memory APIs** stays in the boundary module | **Presupposes a non-existent API.** There are no Headroom memory APIs in the pinned package to import, behind the boundary or anywhere else. The clause is unsatisfiable as written (vacuously true at best). |
| 2 | Memory written in one session retrievable in a later session **and in a workflow run**, asserted by an integration test | **Unachievable.** No persistent store is reachable (M1, M2, M4). Building one is PLAN-040's first non-goal. |
| 3 | Substrate on disk is **local markdown**, human-readable; nothing off-machine | **False premise.** The substrate is SQLite + HNSW + FTS5 (M3). The privacy half is fine and unchanged — SUV-0014 §3.6 already establishes `baseUrl` as the single egress control with a localhost default. |
| 4 | Disabled or absent → sessions and workflows unchanged; memory ops report unavailable, never throw | **Achievable, and already true in substance** — but only trivially, since "unavailable" would be the sole outcome on every path. Landing it alone would ship an interface with no non-degenerate arm. |

---

## 4. Why this was not worked around

Four routes exist to a memory feature. Each is an architectural decision above
SUV granularity, and per ADR-0028 and CLAUDE.md's "never self-scope a plan", not
one is mine to take inside SUV-0029:

1. **Adopt the proxy's injected model tools.** Memory becomes tools the *model*
   calls, injected into the completion request by the proxy — meaning Vorno's
   completions route through Headroom. That directly conflicts with the posture
   SUV-0014 **F3** established (Vorno owns its provider calls; do not drag
   credentials through a third party) and would not sit behind the adapter at
   all. It also inverts SUV-0029's design: nothing would be "exposed through
   memory operations on the boundary adapter".
2. **Adopt the Python client.** Requires a Python sidecar process in a TS
   codebase, and a supervision/lifecycle story Vorno does not have.
3. **Read and write `.headroom/memory.db` directly.** Reverse-engineering an
   undocumented SQLite schema — with embeddings and an HNSW index — belonging to
   a pre-1.0 dependency publishing five patches in three days. Brittle by
   construction, and in substance "building our own memory library" against
   someone else's file.
4. **Contribute memory to the TypeScript SDK upstream.** Best aligned with
   PLAN-040's stated upstream-first posture, and a natural companion to SUV-0030's
   extension interface — but it is upstream work with upstream timelines, not a
   SUV that closes here.

Option 4 is the recommendation. It is offered as a recommendation, not taken.

---

## 5. Knock-on effects

- **SUV-0030** (memory extension interface, "designed against Headroom's
  seams") and **SUV-0031** (agentic-memory v2 as a plugged backend) both inherit
  this premise. SUV-0030 is the plan's *"priority build item"*. Neither is
  necessarily dead — an extension interface for memory storage formats is
  arguably *more* motivated now, since Headroom's own substrate turns out not to
  be the markdown store the plan wanted — but both need re-grounding against M1–M3
  before they are executable.
- **PLAN-040's I2 section** and its "Default substrate: local markdown" bullet
  are factually wrong and have been corrected in place, with a pointer here.
- **PLAN-040 open question 1** (TS SDK vs proxy vs MCP) is no longer only about
  compression. Memory availability now depends on the answer, which raises its
  stakes and argues for the ADR that §I1 already contemplated.
- **The SUV-0014 monthly bump cadence** gains a specific thing to look for: a
  memory API appearing in the TS SDK would unblock this SUV.

---

## 6. Reproduction

Every claim above is re-derivable.

```bash
cd /path/to/craft-agents-oss

# M1 — every endpoint literal in the shipped bundle; no /v1/memory*
grep -ohE "/v1/[a-zA-Z0-9_/]*|/health|/stats[a-z-]*|/metrics|/cache/clear|/debug/[a-z]*" \
  node_modules/headroom-ai/dist/chunk-*.js | sort -u

# M1 — the README never mentions memory
grep -ciE "memory|remember|recall|persist" node_modules/headroom-ai/README.md   # -> 0

# M4 — SharedContext is an in-process Map with a TTL
sed -n '23,60p' node_modules/headroom-ai/dist/index.js

# M5 — no filesystem primitives anywhere in dist
grep -rnE "readFileSync|writeFileSync|mkdirSync|node:fs|child_process" \
  node_modules/headroom-ai/dist/*.js node_modules/headroom-ai/dist/*.cjs   # -> no matches

# M3 — the SDK's own memory path helper names a database
grep -n "function memoryDbPath" -A3 node_modules/headroom-ai/dist/index.js

# All of the above, as an executable tripwire
cd packages/shared && bun test src/headroom/__tests__/sdk-memory-surface.test.ts
```

M6 is reproduced against the machine rather than the repo, so it needs the CLI
installed (`which headroom` → `~/.local/bin/headroom`). These commands write to
`~/.headroom/memory.db`: `stats` creates the file if absent, and `list` is a
read. Neither adds a row — the store showed `Total Memories: 0` before and after.

```bash
headroom --version                    # -> headroom, version 0.36.5 (matches the npm pin)
headroom memory --help                # -> 13 subcommands; no `add`, no `search`
headroom memory stats                 # -> USER / SESSION / AGENT / TURN scopes, 0 rows
sqlite3 ~/.headroom/memory.db ".tables"        # -> memories
sqlite3 ~/.headroom/memory.db ".schema memories"
sqlite3 ~/.headroom/memory.db "select name,type from sqlite_master;"  # -> no FTS5 vtable
ls ~/.headroom                        # -> exists and is populated (corrects the 08-27 log)
ls ~/.headroom/memories               # -> No such file or directory
```

Upstream sources consulted:
[wiki/memory.md](https://github.com/headroomlabs-ai/headroom/blob/main/wiki/memory.md),
[repository README](https://github.com/headroomlabs-ai/headroom).
