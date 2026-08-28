---
id: SUV-0031
title: agentic-memory v2 as a plugged backend behind the interface
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related: []
blocked-by: []
---

# SUV-0031 — agentic-memory v2 as a plugged backend behind the interface

## Goal

Plug the private agentic-memory v2 engine in as a backend behind the SUV-0030
extension interface, and reduce the `agentic-memory` MCP source to a thin host
over it.

## Scope

- A backend implementation of the SUV-0030 interface wrapping the v2 engine —
  its gated loads, logged retrieval, PRG trims, and archive semantics become
  adapter behavior behind Headroom's memory, not a parallel engine.
- The `agentic-memory` MCP source rewired as a thin host over the plugged
  backend: its tools delegate; no engine logic remains in the source itself.
- Deliberately out: changes to the v2 engine's own semantics, and any new
  storage or query capability beyond what the interface carries.

## Acceptance

- [x] The v2 engine is reachable only through the SUV-0030 interface as a registered backend — no session or workflow path calls it directly, verifiable by grep.
- [x] Gated-load, retrieval-logging, and archive semantics behave the same through the plugged backend as before, asserted by tests exercising each through the interface.
- [x] The `agentic-memory` MCP source's tools delegate to the plugged backend, and the source contains no engine logic of its own.
- [x] Behaviors that could not express behind the interface (if any) are listed with the upstream ask that would unblock them, matching plan open question 3.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — **delivered.** Gap list and implementation record:
  [`roadmap/evidence/PLAN-040/agentic-memory-backend-gap-list.md`](../../evidence/PLAN-040/agentic-memory-backend-gap-list.md).
  Code landed in the engine repo `Swagatar-LLC/agentic-memory-template` @ **`1f51329`**
  on `main` (committed, not pushed) — §5 of the gap list records why the diff falls
  there rather than here and how a reviewer can re-examine that call. Nothing
  product-side changed in this repo; `grep -rn "agentic.memory" apps/ packages/`
  returned nothing before this SUV and returns nothing after it.

  **The blocker that wasn't.** SUV-0030 left this SUV facing gap **D** (*"a
  TypeScript path, or an explicit statement that memory is Python/CLI-only"*,
  unanswered upstream), which read as though a registered backend might be
  unreachable. It is not a constraint here: the **`headroom-ai` Python
  distribution is on PyPI at the same 0.36.5 the TS side is pinned to**
  (`packages/shared/package.json`) and ships `headroom/memory/{ports,config,factory}.py`
  entire — and both sides of *this* integration are Python (the v2 engine, and
  the `agentic-memory` stdio server). So this is a real backend loaded by
  upstream's own `factory._load_external_backend`, not a shape-alike. Gap D
  stays open and stays real for Vorno's **TypeScript** session loop (SUV-0029),
  where it always was the problem.

  **What landed.** `lib/agentic_memory/headroom_backend.py` implements
  `MemoryStore` + `TextIndex` over the existing gate; `pyproject.toml` registers
  it under `headroom.memory_store` / `headroom.memory_text`; no `VectorIndex` is
  registered, because this corpus has no embeddings and declining a separately-
  pluggable slot beats faking it. `server/mcp_server.py` no longer imports
  `gate`, `config` or `preflight` at all — it speaks JSON-RPC, renders text, and
  delegates everything between. **The gate is byte-for-byte untouched** (`git
  show --stat 1f51329` names no `gate.py`), which is what "no changes to the v2
  engine's own semantics" required.

  **Evidence, red then green.** `headroom_backend selftest` — 40 checks — is
  *differential*: each result is computed twice, once through the Protocol and
  once through `gate` directly on the same fixture, then compared (admitted
  sets, withheld counts by reason, banner bytes, search ranking, the log record
  field for field). Forcing `include_archive=True` in the adapter turned 5 of
  those red; reverting turned them green. `mcp_server selftest` — 53 checks — is
  the host proof: **50 of them are the pre-existing behavioural assertions,
  unchanged, passing through the new path**, plus a `_check_delegation()`
  tripwire that reports `['gate', 'config', 'preflight']` against the pre-change
  host and `[]` against the rewired one. All twelve other engine module
  selftests still pass (`evals` has no `selftest` subcommand — pre-existing,
  untouched). Live smoke test against the real vault through the plugged
  backend: `status` answered, wrote no log line.

  **Four behaviors could not express, none needing a new ask** (gap list §3):
  a retrieval context that is part of the *contract* rather than a
  `metadata_filters` convention (**A**); withheld-vs-refused distinguishable
  from absent for a caller using the Protocol's own `query()` (**B**) — the
  `search_gated` envelope is implemented locally in the shape proposed upstream;
  gating a by-id `get()`, which carries no context and so **fails closed**,
  answering only for ids a preceding gated query admitted (**A**, and worth
  adding to #3287 explicitly since the issue proposes the context on the filter
  dataclasses only, which does not reach `get()`); and the cold-storage marker
  surviving *downstream compression* (**C**) — inert today because memory
  content does not enter Vorno's compression path, live the moment SUV-0029
  unblocks. Three further contract frictions #3287 does not cover are recorded
  separately in §4 (no settings channel for an EXTERNAL backend; identity must
  be derivable, so path-is-id; read-only is not expressible).

  **Owner gates.** (1) The engine commit is **not pushed** — `agentic-memory-template`
  is a separate repo and pushing it is Jeff's call. (2) The live source config
  now points at `~/dev/agentic-memory-template/.venv/bin/python3`, since the
  server needs `headroom-ai`; prior config preserved at
  `config.json.bak-suv0031-20260827`. Without that venv the tools still list and
  every call names what is missing — there is deliberately no fallback to the
  ungated path. (3) Folder move and frontmatter `status` left to
  `[skill:roadmap-plan-advance]`; the `blocked-by: SUV-0030` edge is left for
  the owner, as SUV-0030 left its own.

- `2026-08-27` — moved from planned to in-progress (retroactive: the delivery
  above happened without the record leaving `planned/`; recorded so the
  transition graph is not skipped).

- `2026-08-27` — **re-verified from primary sources, then moved from in-progress
  to done.** Every figure in the entry above and in the gap list was re-derived
  by running it, not by reading the prior write-up. The full command transcript
  with observed output is now §6 of
  [`agentic-memory-backend-gap-list.md`](../../evidence/PLAN-040/agentic-memory-backend-gap-list.md),
  and §7 of that file records what the pass corrected.

  **One evidence defect found and corrected.** The entry above says *"All twelve
  other engine module selftests still pass (`evals` has no `selftest`
  subcommand)"* — a sentence that contradicts itself. Measured: **eleven** of the
  twelve non-`headroom_backend` engine modules run a selftest and all eleven
  pass; `evals` is the twelfth and exits 2 with a usage message. Also
  `harvest_batches` prints `selftest: 0 failures`, not `SELFTEST PASS`. Both are
  pre-existing and untouched by `1f51329`. Corrected in gap list §7 rather than
  by editing this log.

  **Everything else held.** Re-derived and unchanged: `headroom-ai==0.36.5` is on
  PyPI (queried `pypi.org/pypi/headroom-ai/0.36.5/json`) and matches the TS pin
  at `packages/shared/package.json:100`; that distribution ships
  `headroom/memory/{ports,config,factory}.py`; the entry-point group names match
  upstream's own constants at `factory.py:28-30`; `_create_store` on an
  `EXTERNAL` config returns `agentic_memory.headroom_backend.AgenticMemoryStore`
  with `isinstance(s, MemoryStore) is True`; **no** `headroom.memory_vector`
  entry point is registered; the host imports only stdlib plus
  `headroom_backend`.

  **Red-then-green, observed rather than quoted.** *Acceptance 2:* forcing
  `include_archive=True` at the backend's single gate call site turned the suite
  to `SELFTEST FAIL (40 checks, 5 failed)`, exit 1, naming the five archive- and
  log-parity checks; restoring the line returned `SELFTEST PASS (40 checks, 0
  failed)`, exit 0, and left the engine tree clean (`git status --porcelain`
  empty — the edit was reverted from a `/tmp` copy, never via `git stash`).
  *Acceptance 3:* `_check_delegation()` returns `['gate', 'config', 'preflight']`
  against `04aba2f`'s host and `[]` against `1f51329`'s. *Acceptance 1:* the 53
  host checks are the 50 pre-existing labels plus exactly 3 new ones — proven by
  set difference on the emitted labels (`comm -23` empty: no pre-existing check
  was dropped or reworded), which is stronger than the count comparison the
  entry above relied on. *Untouched engine:* `gate.py`'s blob hash is
  `0a28daf7a7585470a5e2c8665d32590501fae25a` at **both** `04aba2f` and `1f51329`.
  *Live:* the real vault answered `initialize` / `tools/list` /
  `tools/call status` over stdio through the plugged backend, exit 0, and the
  retrieval log stayed at 106 lines.

  **Vorno-side suites, all green on this branch** (the repo-side diff is
  documentation only): `packages/core`, `packages/shared`, `packages/server-core`,
  `packages/ui` `tsc --noEmit` → exit 0 each; `packages/shared` `bun test` →
  3650 pass / 20 skip / 0 fail; `apps/server` `bun test` → 196 pass / 0 fail;
  `bun run test:webui` → 362 pass / 0 fail; `bun run test:doc-tools` → 19 tests
  OK; `lint:i18n:parity` / `:sorted` / `:coverage` → OK; `check-branding.ts` →
  clean (one pre-existing stale-allowlist warning for
  `apps/viewer/vite.config.ts`, non-failing); `check-headroom-boundary.ts` →
  clean.

  **The two owner gates from the entry above are unchanged and still open:** the
  engine commit `1f51329` is committed but **not pushed** (separate repo,
  Jeff's call), and the live source config points at
  `~/dev/agentic-memory-template/.venv/bin/python3` with the prior config
  preserved at `config.json.bak-suv0031-20260827`. Neither is an acceptance
  item, which is why this moves to `done` with both named rather than waiting.

- `2026-08-27` — **third verification pass: every acceptance item re-derived by
  execution; all four hold; no prior figure found wrong.** This pass deliberately
  did not read the previous write-ups for its numbers — it re-ran the commands
  and compared afterwards. Full transcript is §6 of the gap list; what this pass
  added and reconciled is §8. Engine tree clean throughout, `git stash` never
  used (the sabotage was reverted from a `/tmp` copy).

  **Acceptance 1 — reachable only as a registered backend.** Upstream's *own*
  loader does the loading: `factory._create_store` / `_create_text_index` on a
  `MemoryConfig(store_backend=EXTERNAL, store_backend_name="agentic-memory")`
  return `agentic_memory.headroom_backend.AgenticMemoryStore` and
  `…AgenticMemoryTextIndex`, both `isinstance` of the Protocols → `True`. The
  two registered group names are upstream's constants verbatim
  (`factory.py:28` `headroom.memory_store`, `factory.py:30` `headroom.memory_text`);
  `entry_points(group="headroom.memory_vector")` is `[]` — the slot is declined,
  not faked. Product-side, `grep -rn "agentic.memory" apps/ packages/` returns
  nothing. **That grep is weak evidence and is named as such** — it returned
  nothing before this SUV too, so the load-bearing proof for item 1 is the
  factory load above plus the host tripwire below, not the grep.

  **Acceptance 2 — parity, red then green, observed.** `headroom_backend
  selftest` → `SELFTEST PASS (40 checks, 0 failed)`, exit 0. Forcing
  `include_archive=True` at the single gate call site
  (`headroom_backend.py:339`, the only `_gate.gate(` in the module) →
  `SELFTEST FAIL (40 checks, 5 failed)`, exit 1, naming *gated load returns
  exactly what the gate returns*, *withheld counts match the gate's, by reason*,
  *cold storage is excluded from a routine load*, *the archive trim is counted,
  not silent*, and *the log record is identical to the engine's, field for
  field*. Restoring → 40/0, exit 0, `git status --porcelain` empty. The suite is
  differential — each result computed through the Protocol and through `gate` on
  the same fixture, then compared — so these five are parity failures, not
  assertion drift.

  **Acceptance 3 — the host hosts, and nothing else. One proof added.** The
  static tripwire holds: `_check_delegation()` returns
  `['gate', 'config', 'preflight']` against `04aba2f`'s host and `[]` against
  `1f51329`'s. The host's entire import list is `json, os, re, subprocess, sys`,
  `tempfile`, and one engine import — `headroom_backend`. Set difference on the
  emitted labels (not a count): the pre-change host passes `SELFTEST PASS (50
  checks, 0 failed)`, `comm -23` is **empty** — no pre-existing check dropped or
  reworded — and `comm -13` is exactly three new delegation checks, giving 53.
  **New in this pass:** the tripwire only proves the host does not *import* the
  engine, which would still permit a host that ignores the backend. So the
  archive sabotage was left applied to the *backend* and the *host* suite re-run:
  it goes red too — `SELFTEST FAIL (53 checks, 2 failed)`, exit 1. A backend
  fault reaching the host's behavioural checks is only possible if the host
  genuinely sources its answers from the backend. Static and dynamic proof now
  both stand.

  **Acceptance 4 — the gap list answers plan open question 3.** Gap list §3 lists
  four behaviors that could not express, each naming its unblocking ask in
  headroomlabs-ai/headroom#3287 (3.1 retrieval context → **A**; 3.2
  withheld-vs-refused → **B**; 3.3 gated by-id `get()` → **A**, with the noted
  need to extend #3287, which proposes the context on the filter dataclasses only
  and so does not reach `get()`; 3.4 cold-storage marker through compression →
  **C**). §4 records three further contract frictions #3287 does not cover
  (no settings channel for an EXTERNAL backend; identity must be derivable, so
  path-is-id; read-only is not expressible), offered as additions rather than new
  asks. Plan open question 3 asks exactly *"how much … expresses cleanly as a
  backend vs. needing interface support upstream"* — §§3–4 are that answer.

  **Untouched engine, re-confirmed.** `gate.py`'s blob is
  `0a28daf7a7585470a5e2c8665d32590501fae25a` at **both** `04aba2f` and `1f51329`
  — identical content, which is stronger than its absence from `--stat`. Eleven
  of the twelve other engine modules run a selftest and all eleven pass (`gate`
  69, `decay` 54, `digest` 45, `retrieval_report` 33, `archive` 28, `config` 22,
  `policy_audit` 19, `decide` 14, `preflight` 12, `control_manifest` 7,
  `harvest_batches` `selftest: 0 failures`); `evals` is the twelfth and exits 2
  with a usage message — pre-existing, untouched. **This confirms rather than
  re-corrects the §7 correction from the second pass.**

  **Live, against the real vault.** `initialize` / `tools/list` / `tools/call
  status` over real stdio through the plugged backend: exit 0, tools
  `['load_context', 'retrieve', 'status']`, `isError: false`, status reporting
  head `613cffa` / branch `main` / clean tree / 12 scopes — and the retrieval log
  stayed at **106 lines**, i.e. `status` retrieves nothing and so logs nothing.

  **All ten CI gates re-run and green** (the repo-side diff remains documentation
  only): `packages/core|shared|server-core|ui` `tsc --noEmit` → exit 0 each;
  `packages/shared` `bun test` → **3653 pass / 20 skip / 0 fail** (3673 across
  211 files); `apps/server` `bun test` → 196 pass / 0 fail; `bun run test:webui`
  → 362 pass / 0 fail; `bun run test:doc-tools` → 19 tests, OK;
  `lint:i18n:parity` / `:sorted` / `:coverage` → exit 0 each; `check-branding.ts`
  → exit 0, clean (one pre-existing non-failing stale-allowlist warning for
  `apps/viewer/vite.config.ts`); `check-headroom-boundary.ts` → exit 0,
  `headroom-ai` imported only by `packages/shared/src/headroom/sdk-adapter.ts`.

  **One figure moved, benignly.** The entry above records `packages/shared` at
  3650 pass; this pass measured 3653. The delta is commit `3619730f` (SUV-0023),
  which landed after that measurement and added exactly three cases to
  `tool-result-context-headroom.test.ts` (10 → 13 declarations). The earlier
  figure was correct when taken. Traced rather than assumed, and recorded in
  gap list §8.

  **The two owner gates are still open and unchanged**, as stated above: engine
  commit `1f51329` is committed but **not pushed**, and the live source config
  points at `~/dev/agentic-memory-template/.venv/bin/python3` with the prior
  config preserved at `config.json.bak-suv0031-20260827` (both re-confirmed by
  inspection this pass). Neither is an acceptance item. Also unchanged and worth
  restating for a reader: **gap D remains open for Vorno's TypeScript session
  loop (SUV-0029)** — this SUV's two ends are both Python, so nothing in the
  Electron/TS product consumes the plugged backend yet. That is a PLAN-040-level
  boundary, not an SUV-0031 acceptance item.
