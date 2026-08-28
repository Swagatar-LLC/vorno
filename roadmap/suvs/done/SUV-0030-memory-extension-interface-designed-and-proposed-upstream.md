---
id: SUV-0030
title: Memory extension interface designed and proposed upstream
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related: []
blocked-by: []
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

- `2026-08-27` — moved from planned to in-progress: re-verification pass opened.
- `2026-08-27` — **independently re-verified, five evidence defects corrected, moved from in-progress to done.**

  Every §9 reproduction command was re-run against **primary sources** — the pinned
  bytes under `node_modules/headroom-ai/` and the GitHub API — rather than against
  the doc's own prose. The design conclusions all survived; the doc's evidence
  hygiene did not. Full record in doc **§10**.

  **Confirmed unchanged (the load-bearing findings):** H1 — `computeBiases`' return
  value is discarded, in the pinned bundle (`chunk-2NXG6XPP.js:1082`) *and* at source
  on `main` (`sdk/typescript/src/compress.ts`: `biases` declared L53, assigned L55,
  never read; `client.compress()` gets only `{ model, tokenBudget }` at L60). H2 —
  `on_pipeline_event` has **0 occurrences** package-wide; `pipelineTiming`
  (`index.d.ts:367`) is the only `pipeline` hit and is a stats field. The upstream
  Python seam is real: `ports.py` Protocols, `EXTERNAL` on all three enums
  (`config.py` L25/34/41), entry-point loader (`factory.py` L28–30/L41/L57). Issue
  [#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) is `open`,
  `comments=0`, author `jhampton`, `created=2026-08-27T04:20:38Z`. Every `Memory` and
  `MemoryFilter` field §2.2/§2.3 relies on exists as described — including
  `entity_refs`, whose any-of reading is upstream's own inline comment.

  **Five defects corrected — none changed a conclusion, all would have failed a
  reader reproducing the work:**
  1. **§9's H3 command was annotated `-> 0` and actually returned `3`.** `grep -ci`
     matched the English word "external" in three prose lines about PostgreSQL/Mem0.
     This was the one defect that could fairly have read as fabrication. Replaced
     with a case-sensitive form, re-run, and it now genuinely returns 0.
  2. **H3 was overstated.** `wiki/memory.md` *does* document the Protocol/ports layer
     (L518 "Protocol-Based Design", L555 `MemoryStore`→`SQLiteMemoryStore`, L612
     "Protocol-based extensibility ✅"). Only the third-party **registration**
     mechanism is undocumented. H3 and gap E narrowed — gap E is a smaller, more
     accurate ask than "the seam is entirely undocumented".
  3. **§3.1 misquoted the agentic-memory source guide** — "server" for **backend**,
     and it equated this interface's ceiling with v2's. The guide (L19) draws v2's
     line at **trims 1–2**; this interface reaches **1–3** (subject trim is
     expressible via `entity_refs`). Corrected with the verbatim quote.
  4. **§5 called all three duplicate-check hits "bugs in the shipped Mem0 adapters."**
     Only #2897 is Mem0-specific; #2898 is MCP stdio lifecycle, #2947 is an
     `entity_refs` sanitization fix in the shared search path. Replaced with actual
     titles and states (all closed).
  5. **§5 pinned drifting counters** (67,721 stars / 549 open issues) as stable
     evidence; they moved to 67,730 / 550 between passes. Now recorded to order of
     magnitude with an explicit "expect a different number" note.

  **`blocked-by` cleared** per `[skill:roadmap-plan-advance]` step 4 (non-blocked
  transitions clear the edge). The prior entry left it to the owner, but a record in
  `done/` still carrying a live `blocked-by` is read literally by the corpus
  validator and the console — done-but-blocked is a worse artifact than an edge
  cleared with its reasoning on the record. The reasoning is the prior entry's and
  stands: the deliverable is an artifact *about* Headroom's interface plus an
  outreach act, neither of which needs a Vorno-reachable memory API.

  **Still doc-only — no product code, no test, no `node_modules` or package change.**
  Diff is confined to `roadmap/`. The tripwire test for H1/H2 remains deliberately
  unwritten (doc §8) and is SUV-0031's to carry if it depends on those facts.

- `2026-08-27` — **third verification pass after the second was rejected on
  adversarial verification; the reproduction failure is root-caused and five
  further defects corrected. Design conclusions unchanged; SUV stays `done`.**
  Full record in doc **§11**.

  **Root cause of "evidence does not reproduce": the dependency was not installed.**
  `node_modules/headroom-ai/` held only `README.md` and `package.json` — **no
  `dist/`** — so five of the six pinned-SDK commands in §9 failed with *No such
  file or directory*. The bytes were never wrong; the checkout was incomplete.
  `bun install --frozen-lockfile` restored `dist/`, after which all six reproduced
  exactly as recorded. §9 now opens with that precondition and the restoring
  command. **Standing lesson: "the evidence is unreproducible" and "the package is
  not installed" are indistinguishable from the outside, and an evidence doc that
  reads `node_modules/` must state its install precondition or it will be graded
  as fabrication.**

  **Everything re-derived from primary sources this pass** (not carried over from
  §10's annotations): S1 `types-BTrX7__W.d.ts:35–49`; H1 bundle L1082 bare `await`,
  L1085 `client.compress(…, { model, tokenBudget })`; H1 at source on `main`
  (`compress.ts` `biases` L53/L55, never read, compress L60); H2 one `pipeline`
  hit (`index.d.ts:367 pipelineTiming`), `on_pipeline_event` 0 package-wide;
  `ports.py` six `@runtime_checkable` Protocols L262/459/556/636/685/800 and all
  thirteen `MemoryStore` methods; `MemoryFilter` field-for-field, incl.
  `entity_refs … # Any of these entities` at `ports.py:42`; `config.py` EXTERNAL
  L25/34/41 + `*_backend_name` L100/105/118; `factory.py` groups L28–30, loader
  L41, `entry_points` L57, docstring L50; `wiki/memory.md` 753 lines, case-
  sensitive registration grep **0** / case-insensitive **3**, Protocol layer at
  L518/529/555/612; POLICY §3's eight steps L48–55; guide L19 verbatim; issue
  [#3287](https://github.com/headroomlabs-ai/headroom/issues/3287) `open`,
  `comments=0`, `user=jhampton`, `created=2026-08-27T04:20:38Z`; #2897/#2898/#2947
  all closed with the tabled titles.

  **Five defects corrected — none changed a conclusion:**
  1. **§9 had no install precondition** (above) — the defect that made the SDK
     evidence read as unreproducible.
  2. **§3.1 contradicted its own table for two passes.** It capped the interface
     at "trims 1–3", but §3 row 6 (write-side inheritance, PRG step 6, `POLICY.md`
     L53) is the *only* row whose *Needs* column is empty. The ceiling is **1–3
     and 6** — **two** trims above v2's 1–2, not one. Each prior pass checked the
     prose and the table separately, never against each other.
  3. **§10.1's H1 row misstated adjacency** ("the next line calls
     `client.compress`" — the next line is `}`; L1084 constructs the client,
     L1085 calls compress), on the document's most load-bearing finding.
  4. **§5's "~550 open issues" had drifted to 564** (stars 67,721 → 67,730 →
     67,749). The hedge was right and the figure still wrong, so exact counters
     are now out of the table entirely and kept only as three dated observations.
  5. **§9's positive-half annotation omitted L612**, cited in §1.2's prose, and
     its command omitted the pattern that finds it. Command and output now agree.

  **Suites run and reported as observed.** `bun run typecheck` — clean.
  `packages/shared` headroom + docs + config tests — **358 pass, 3 skip, 0 fail**.
  `apps/server` — **196 pass, 0 fail**. `lint:headroom-boundary` — pass.
  **Pre-existing failures, none caused here and none in a file this SUV touched:**
  `bun run lint` aborts at `lint:ipc-sends` because `scripts/check-raw-sends.sh`
  **does not exist at HEAD** (same for `lint:tool-name-checks` →
  `check-task-tool-checks.sh`); `lint:shared` reports 5 `no-inline-source-auth-check`
  errors in `resources/__tests__/resource-bundle.test.ts`,
  `sources/__tests__/token-refresh-manager.test.ts` and
  `sources/token-refresh-manager.ts`; `lint:ui` reports 3 errors. All are in
  committed files unrelated to this diff.

  **No test written, deliberately** — no acceptance item asks for one and doc §8
  records the tripwire as an out-of-scope diff; so there is no red-then-green to
  report. **Still doc-only:** the diff is one file under `roadmap/`. The working
  tree also carries a pre-existing modification to
  `packages/shared/src/agent/__tests__/tool-result-context-headroom.test.ts`
  (SUV-0023 work from another session) which was **left untouched and excluded
  from the commit by pathspec** — not stashed.
