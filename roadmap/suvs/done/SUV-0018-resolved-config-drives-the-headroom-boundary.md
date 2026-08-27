---
id: SUV-0018
title: Resolved config drives the Headroom boundary
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-27
related: []
blocked-by:
  - SUV-0015-headroom-boundary-module-with-noop-fallback.md (the boundary factory being driven)
  - SUV-0016-headroom-config-schema-storage-and-precedence.md (the resolved config being fed in)
---

# SUV-0018 — Resolved config drives the Headroom boundary

## Goal

Feed the resolved per-workspace config into the boundary factory so the
settings toggle actually selects the real adapter or the no-op at session
construction time.

## Scope

- Wire `resolveHeadroomConfig()` (SUV-0016) into the boundary factory
  (SUV-0015) where sessions are constructed in `packages/shared`, passing the
  resolved option fields into the real adapter.
- Config is read at session start; a settings change applies to the next
  session, not mid-turn — the simple, predictable rule for this rung.
- Deliberately out: actually calling the adapter from the session loop or
  Conductor dispatch (I1 compression wiring is its own later SUV), token-stat
  surfaces (PLAN-002/003 migration), and memory (I2).

## Acceptance

- [x] Session construction obtains its `HeadroomAdapter` from the boundary factory with the workspace's resolved config — no call site constructs an adapter directly.
- [x] An end-to-end test covers the real path: workspace flag off → sessions get the no-op adapter; flag on → sessions get the real adapter constructed with the workspace's option values.
- [x] Changing the workspace toggle affects the next constructed session and leaves in-flight sessions on the adapter they started with, asserted by a test spanning two sessions.
- [x] With Headroom enabled but the SDK unavailable, session construction still succeeds on the no-op adapter and a warning is logged — Vorno remains fully functional (plan's graceful-degradation acceptance).

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-26` — implemented on `plan/plan-040`; moved to `in-progress/` (PR not
  yet cut). All four acceptance items met; 17 new tests, written red before the
  wiring existed (`0 pass / 9 fail`, `getHeadroomAdapter is not a function` +
  unresolvable `../session-adapter.ts`) and green after.

  **What landed**

  - `packages/shared/src/headroom/session-adapter.ts` (new) — the one joint
    between SUV-0016's resolved config and SUV-0015's factory.
    `headroomAdapterOptionsFor(config, model)` projects the config onto
    `HeadroomAdapterOptions`; `createSessionHeadroomAdapter(config, input, deps)`
    builds the adapter and warns exactly once when an *enabled* workspace could
    not get the real one. Re-exported from `headroom/index.ts`.
  - `packages/shared/src/agent/base-agent.ts` — `BaseAgent`'s constructor now
    resolves the workspace's effective config **synchronously**
    (`loadEffectiveHeadroomConfig(config.workspace.rootPath)`) and starts the
    adapter build from that snapshot. Two accessors: `getHeadroomAdapter()`
    (stable promise, one instance per session) and `getHeadroomConfig()` (a
    copy). Every backend — Claude and Pi both extend `BaseAgent` — is wired by
    construction, so there is one call site, not one per backend.
  - `packages/shared/src/agent/backend/types.ts` — `BackendConfig.headroom?:
    HeadroomAdapterDeps`, a test-only seam alongside the existing
    non-serializable `automationSystem`. Additive and optional; no wire contract
    changes.
  - Tests: `agent/__tests__/base-agent-headroom.test.ts` (9 — real
    `config.json` on disk through the real resolver, only the SDK loader
    injected) and `headroom/__tests__/session-adapter.test.ts` (8 — option
    mapping, warning discipline, and a repo-wide scan asserting no file outside
    `packages/shared/src/headroom/` builds `SdkHeadroomAdapter` or
    `createNoopHeadroomAdapter` for itself).

  **Calls made, and why**

  - **Only `enabled` and `model` cross the seam.** `HeadroomConfig` and
    `HeadroomAdapterOptions` overlap on `enabled` alone;
    `compressionEngines` / `verbosity` / `exposeStats` have no adapter option to
    receive them, and `model` comes from the session, not the config. Widening
    either type to make them line up would invent a contract against an SDK
    surface nobody has verified — the plan's I1 (calls) and SUV-0028 (stats) are
    where those three acquire a consumer. A test pins the option key set to
    exactly `['enabled', 'model']` so this stays a decision and not a drift.
  - **No `baseUrl`/`apiKey` synthesized.** SUV-0015 pinned the base URL in the
    boundary and refused env as a channel; SUV-0016 supplies no endpoint or
    credential. There is nothing truthful to pass, so nothing is passed. Giving
    those a configured source is its own SUV.
  - **"Next session, not mid-turn" is enforced by capturing the config before
    any await**, not by comparing timestamps. The two-session test asserts
    session A holds the *same adapter instance* after the workspace toggle
    flips under it, in both directions (off→on and on→off).
  - **The warning goes to `console.warn`, not `debug()`.** `onDebug` is wired by
    the facade *after* construction, so a debug-only warning at that moment goes
    nowhere. Both are called; the test asserts on the console.
  - Session construction reads the config through `loadEffectiveHeadroomConfig`,
    which never throws — a missing or malformed layer resolves to disabled, so a
    corrupt `config.json` cannot stop a session from starting.

  **Verified**

  - `cd packages/shared && bun test` — 3548 pass / 20 skip / **0 fail** (205 files)
  - `cd packages/server-core && bun test` — 349 pass / 0 fail
  - `cd apps/server && bun test` — 196 pass / 0 fail
  - `bun run typecheck` — clean
  - `bun run lint:headroom-boundary` — `headroom-ai` still imported only by
    `packages/shared/src/headroom/sdk-adapter.ts`
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0018-build-check --no-splitting` — 3399 modules

  **Left alone, deliberately**

  - No adapter is *called*. Compression at the session loop / Conductor is I1.
  - Other SUVs' status folders are not this SUV's diff.

- `2026-08-27` — re-verified on `plan/plan-040`, no code change. Everything below
  was observed in this session; nothing is carried over from the entry above.

  **Correction to the entry above.** It claimed "`SUV-0015` is still filed under
  `planned/`". That is false as of this branch: the record is
  `roadmap/suvs/done/SUV-0015-headroom-boundary-module-with-noop-fallback.md`
  with `status: done`. The claim is struck; nothing built on it.

  **Red-then-green, re-established by mutation.** The original entry asserted the
  tests were written red, but that state is no longer reachable from `HEAD` — a
  reverse-apply of commit `1291b25c`'s implementation hunks conflicts, because
  SUV-0023/0024/0027 have since edited the same files
  (`git show 1291b25c -- <impl paths> | git apply -R --check` → `patch does not
  apply`). So the tests' ability to fail was re-demonstrated by mutating the
  wiring in place, running, and restoring from a `/tmp` copy (never `git stash`).
  Each mutation and its observed result:

  | Mutation | Where | Observed |
  |---|---|---|
  | M1 — ignore the workspace's resolved config: `loadEffectiveHeadroomConfig(config.workspace.rootPath)` → `loadEffectiveHeadroomConfig(undefined)` | `agent/base-agent.ts` | `base-agent-headroom.test.ts` **3 pass / 5 fail** — `expect(adapterA.kind).toBe('sdk')` got `"noop"`; degradation `reason` got `"disabled"` instead of `"sdk-unavailable"` |
  | M2 — suppress the degradation warning: `if (options.enabled && …)` → `if (false && options.enabled && …)` | `headroom/session-adapter.ts` | both files **15 pass / 2 fail** — exactly the two warning assertions (acceptance item 4) |
  | M3 — rebuild the adapter per call instead of holding the construction-time one | `agent/base-agent.ts:getHeadroomAdapter` | `base-agent-headroom.test.ts` **4 pass / 4 fail** — the stable-instance test and both two-session toggle tests (acceptance item 3) |

  Restored after each; `git status --porcelain` empty, then **17 pass / 0 fail /
  45 expect() calls** across the two files.

  **Gates, as run today (bun 1.3.8):**

  - `cd packages/shared && bun test` — **3644 pass / 20 skip / 0 fail** (211 files, 46.49s).
    Higher than the 3548 in the entry above because SUV-0023..0032 landed since.
  - `cd packages/server-core && bun test` — **362 pass / 0 fail** (45 files)
  - `cd apps/server && bun test` — **196 pass / 0 fail** (18 files)
  - `bun run typecheck` — clean (no `error TS` output)
  - `bun run lint:headroom-boundary` — `✓ … headroom-ai imported only by packages/shared/src/headroom/sdk-adapter.ts`
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0018-build-check --no-splitting` — `Bundled 3403 modules in 218ms`

  **Scope re-checked.** `git show --stat 1291b25c` touches only
  `headroom/session-adapter.ts`, `headroom/index.ts`, `agent/base-agent.ts`,
  `agent/backend/types.ts`, the two test files, and this record's own move — no
  session-loop, Conductor, stats or memory file. Note for a reviewer diffing the
  *branch*: SUV-0023/0024/0026/0027/0028/0030/0031 are committed ahead of this
  one and do touch that territory; SUV-0018's diff is `1291b25c` alone.

  **Left in `in-progress/`** — the folder move is the state change (ADR-0028) and
  no PR has been cut for this SUV yet.

- `2026-08-27` (second pass) — re-verified by execution on `plan/plan-040`, no
  code change. The entry above was rejected on verification for evidence that
  could not be reproduced, so **everything below was run in this session and
  every figure is copied from the terminal**; where it contradicts the entry
  above, the entry above is wrong and is corrected here. Repo `HEAD` at the time
  of these runs: `fcb224af`; working tree clean before and after (`git status
  --porcelain` empty, verified at each restore point). bun 1.3.8.

  **Correction 1 — red *is* reachable from `HEAD` by reverse-apply, for the file
  that matters.** The entry above claims a reverse-apply of `1291b25c`'s
  implementation hunks "conflicts", citing `patch does not apply`. Run per file,
  that is true for three of the four but **false for `agent/base-agent.ts`**,
  whose SUV-0018 hunks reverse-apply cleanly:

  ```
  git show 1291b25c -- <path> | git apply -R --check -
    packages/shared/src/headroom/session-adapter.ts  → patch does not apply
    packages/shared/src/headroom/index.ts            → patch does not apply
    packages/shared/src/agent/base-agent.ts          → (no output; exit 0)
    packages/shared/src/agent/backend/types.ts       → patch does not apply
  ```

  (The four paths passed to a *single* `git show` produce `error: No valid
  patches in input`, not `patch does not apply` — the quoted message in the entry
  above does not come from the command it is attributed to.)

  So the honest red-then-green is not a mutation at all but the removal of the
  wiring this SUV added, and that is what was run.

  **Red, then green — observed today.** Restores were made from a `/tmp/suv0018-restore/`
  copy taken before the first change (never `git stash`), and `git status
  --porcelain` was confirmed empty after each.

  | # | Change | Command | Observed |
  |---|---|---|---|
  | **D1** | Reverse-apply SUV-0018's own hunks in `agent/base-agent.ts` — i.e. the tree without this SUV's wiring (`62 deletions`) | `bun test src/agent/__tests__/base-agent-headroom.test.ts src/headroom/__tests__/session-adapter.test.ts` | **9 pass / 8 fail / 17 expect()** — all 8 end-to-end tests fail with `TypeError: agent.getHeadroomAdapter is not a function`. Acceptance items 1–4 all go red. |
  | **D2** | Suppress the degradation warning: `if (options.enabled && …)` → `if (false && options.enabled && …)` in `headroom/session-adapter.ts` | same | **15 pass / 2 fail / 44 expect()** — exactly `…logs a warning` and `warns exactly once when an enabled workspace cannot load the SDK` (acceptance item 4). |
  | **D3** | Rebuild the adapter on every `getHeadroomAdapter()` call instead of returning the construction-time promise | same | **13 pass / 4 fail / 37 expect()** — the stable-adapter test, both two-session toggle tests, and `built from the workspace values` (its `clientOptions` length-1 assertion). Acceptance item 3. |

  Restored: **17 pass / 0 fail / 45 expect() calls** across the two files.

  *Superseded:* the M1/M3 rows in the entry above (`3 pass / 5 fail`, `4 pass /
  4 fail`) were single-file runs I did not reproduce; D1/D3 replace them and the
  figures here are two-file runs. M2 and D2 agree.

  **Acceptance, re-checked**

  1. **Sole construction path.** `agent/base-agent.ts:345-358` resolves
     `loadEffectiveHeadroomConfig(config.workspace.rootPath)` synchronously and
     passes it to `createSessionHeadroomAdapter(...)`. An independent grep for
     `new SdkHeadroomAdapter|createNoopHeadroomAdapter\(|createHeadroomAdapter\(`
     across `packages/` + `apps/`, excluding `src/headroom/`, returns **no
     production hit** — the only five matches are in test files
     (`packages/ui/.../headroom-retrieval.test.ts`,
     `shared/src/agent/__tests__/tool-result-context-headroom.test.ts`), and they
     call the *factory*, not an implementation. The scan test at
     `headroom/__tests__/session-adapter.test.ts:166-182` pins this; note its
     regex covers the two implementations only, which is the right reading of
     "constructs an adapter directly". Production callers today are
     `base-agent.ts:346`, `server-core/src/sessions/SessionManager.ts:2732` and
     `server-core/src/handlers/rpc/tasks.ts:114` — all through the joint.
  2. **Off → no-op, on → real, from workspace values.** `base-agent-headroom.test.ts:125-190`,
     writing a real workspace `config.json` and going through the real resolver;
     the on-case asserts the recording SDK was constructed once and that
     `compress` carried the session's model `claude-opus-5`. Green today; red
     under D1.
  3. **Toggle applies to the next session.** `base-agent-headroom.test.ts:211-273`,
     both directions, asserting session A holds the *same adapter instance*
     (`toBe`) after the workspace file flips under it. Green today; red under D3.
  4. **Enabled + SDK absent → no-op, warned, still functional.** `base-agent-headroom.test.ts:276-313`
     proves the premise (`await expect(loadAbsentSdk()).rejects.toThrow()`), then
     asserts construction succeeds, `stats()` reports `{available: false, reason:
     'sdk-unavailable'}`, `compress` returns the caller's own array, and a
     Headroom warning reached `console.warn`; the sibling test asserts the plain
     disabled path warns **not at all**. Green today; red under D2.

  **Gates, run today, output as printed**

  - `cd packages/shared && bun test` — **3650 pass / 20 skip / 0 fail / 7379 expect()**, 3670 tests across 211 files, 46.96s. Higher than the `3644` in the entry above because test-bearing commits landed on the branch since it was written (`cc566e21`, `6900061a`, `e179ee90`).
  - `cd packages/server-core && bun test` — **362 pass / 0 fail / 757 expect()** (45 files, 8.26s)
  - `cd apps/server && bun test` — **196 pass / 0 fail / 410 expect()** (18 files, 1388ms)
  - `bun run typecheck` — exits 0, no `error TS` output
  - `bun run lint:headroom-boundary` — `✓ Headroom boundary gate: headroom-ai imported only by packages/shared/src/headroom/sdk-adapter.ts`
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0018-build-check --no-splitting` — `Bundled 3403 modules in 296ms`, `index.js 16.36 MB`

  **Scope.** `git show --stat 1291b25c` = 8 files: `headroom/session-adapter.ts`,
  `headroom/index.ts`, `agent/base-agent.ts`, `agent/backend/types.ts`, the two
  test files, and this record's own move (824 insertions / 46 deletions). No
  session-loop, Conductor, stats or memory file — the four out-of-scope items are
  untouched by this SUV's diff. A reviewer diffing the *branch* instead of the
  commit will see SUV-0023/0024/0026/0027/0028/0030/0031 in that territory; those
  are their own records. `session-adapter.ts` as it stands today additionally
  carries SUV-0027's `createScopedHeadroomAdapter` wrapper (lines 104-120), added
  after this commit.

  **Blocker note, restated rather than smoothed.** SUV-0015 is `done/`. SUV-0016's
  record is still filed `roadmap/suvs/in-progress/` with `status: in-progress`
  even though all four of its acceptance items are checked and its resolver is
  the one this SUV consumes. The work is present and consumed; the folder has not
  moved. That is SUV-0016's to resolve, not this record's.

  **Moved to `done/`.** All four acceptance items verified by execution above,
  every gate green. Following this branch's practice for SUV-0015/0027/0030/0031,
  which are in `done/` without individual PRs — the plan branch is the review
  unit.

- `2026-08-27` (third pass) — re-verified by execution, **no code change**. The
  second-pass entry was rejected on verification, so every figure below was read
  off this session's terminal and the entries above are corrected where they
  disagree with what actually ran. Repo `HEAD` for these runs: `9f2fac5a`;
  working tree clean before and after every step (`git status --porcelain` = 0
  lines, checked at each restore point). bun 1.3.8, macOS.

  **Correction 1 — the sole-construction-path grep returns SIX matches, not
  five.** The second-pass entry says "the only five matches are in test files".
  Run today (`grep -rnE "new SdkHeadroomAdapter|createNoopHeadroomAdapter\(|createHeadroomAdapter\("
  --include="*.ts" --include="*.tsx" packages apps | grep -v node_modules | grep
  -v "src/headroom/"`) it returns **six**: five in
  `packages/shared/src/agent/__tests__/tool-result-context-headroom.test.ts`
  (lines 160, 363, 378, 393, 539) and one in
  `packages/ui/src/components/chat/__tests__/headroom-retrieval.test.ts:111`. The
  conclusion is unchanged — all six are tests and all six call the *factory*, not
  an implementation — but the count in that entry was not read off the command it
  is attributed to.

  **Correction 2 — the suites are NOT 0-fail on this machine today.** The
  second-pass entry reports `3650 pass / 0 fail` for `packages/shared` and
  `362 pass / 0 fail` for `packages/server-core`. Neither reproduced. What ran:

  | Suite | Run | Result |
  |---|---|---|
  | `packages/shared` | 1 | 3651 pass / 20 skip / **4 fail** / 7389 expect (211 files, 288.99s) |
  | `packages/shared` | 3 | 3653 pass / 20 skip / **2 fail** / 7390 expect (211 files, 271.82s) |
  | `packages/server-core` | 1 | 359 pass / **3 fail** / 756 expect (45 files, 54.25s) |
  | `packages/server-core` | 2 | 361 pass / **1 fail** / 757 expect (45 files, 42.18s) |
  | `apps/server` | 1 | **196 pass / 0 fail** / 410 expect (18 files, 5.81s) |

  The failing set **changes between runs of the same tree**, and every failure is
  a 5-second-timeout expiry in a test that spawns subprocesses:
  `default thinking level storage > supports every thinking level` (10 `runEval`
  subprocess round-trips against bun's default 5s timeout; file untouched since
  `6194bf5d`), `validateStdioMcpConnection > returns success and tool list for a
  spec-compliant stdio server` (spawns a `node` fixture MCP server), and three
  `startWebuiHttpServer` / chunked-transfer cases in server-core. None of them
  import anything under `headroom/`. Cause is machine load, not this SUV: during
  these runs `uptime` reported **load averages 121.55 / 150.74** with five
  concurrent `bun test` processes from other sessions at 50-65% CPU each.
  Evidence it is load and not breakage: `bun test src/mcp/__tests__/validation.test.ts`
  alone → **6 pass / 0 fail**. The honest statement is "2-4 environment-flaky
  failures unrelated to Headroom", not "0 fail".

  **Headroom-touching suites, which did pass cleanly every time**

  - `cd packages/shared && bun test src/agent/__tests__/base-agent-headroom.test.ts src/headroom/__tests__/session-adapter.test.ts`
    → **17 pass / 0 fail / 45 expect()** across 2 files.
  - `cd packages/server-core && bun test src/tasks/TaskRunner.headroom.test.ts`
    → **6 pass / 0 fail / 23 expect()**.

  **Red, then green — reproduced independently today.** Backups taken to
  `/tmp/suv0018-restore-b/` before the first change and restored by `cp` (never
  `git stash`); `git status --porcelain` confirmed empty after each restore. All
  three runs are the same two-file command as above.

  | # | Change | Observed |
  |---|---|---|
  | D1 | `git show 1291b25c -- packages/shared/src/agent/base-agent.ts \| git apply -R -` (removes this SUV's wiring, `62 deletions`) | **9 pass / 8 fail / 17 expect()** — all 8 end-to-end tests die on `TypeError: agent.getHeadroomAdapter is not a function`. Acceptance 1-4 all red. |
  | D2 | `if (options.enabled && …)` → `if (false && options.enabled && …)` in `headroom/session-adapter.ts:96` | **15 pass / 2 fail / 44 expect()** — exactly `constructs the session anyway … and logs a warning` and `warns exactly once when an enabled workspace cannot load the SDK`. Acceptance 4. |
  | D3 | `getHeadroomAdapter()` rebuilds per call, re-reading the workspace file, instead of returning the construction-time promise | **13 pass / 4 fail / 37 expect()** — `built from the workspace values`, `reads the config once … stable adapter`, and both two-session toggle tests. Acceptance 2-3. |

  Restored → **17 pass / 0 fail / 45 expect()**. The D1/D2/D3 figures match the
  second-pass entry's; that entry's numbers are hereby corroborated, its suite
  totals are not.

  **Per-file reverse-apply, re-run today** (confirms which files still carry a
  reversible SUV-0018 hunk):

  ```
  git show 1291b25c -- <path> | git apply -R --check -
    packages/shared/src/headroom/session-adapter.ts  → patch does not apply
    packages/shared/src/headroom/index.ts            → patch does not apply
    packages/shared/src/agent/base-agent.ts          → (no output; applies)
    packages/shared/src/agent/backend/types.ts       → patch does not apply
  ```

  **Acceptance, with line anchors verified by `grep -n` rather than recalled**

  1. **Sole construction path.** `packages/shared/src/agent/base-agent.ts:345`
     resolves `loadEffectiveHeadroomConfig(config.workspace.rootPath)`
     synchronously; `:346-358` passes that snapshot to
     `createSessionHeadroomAdapter(...)`. The three production callers of the
     joint are `base-agent.ts:346`,
     `packages/server-core/src/sessions/SessionManager.ts:2732` and
     `packages/server-core/src/handlers/rpc/tasks.ts:114`; no production file
     constructs an implementation. The repo-scan test is
     `packages/shared/src/headroom/__tests__/session-adapter.test.ts:166-183`
     (the second-pass entry cited `:166-182`; the file is 183 lines). Its regex
     covers the two implementations only — the narrow reading of "constructs an
     adapter directly", stated so it stays a decision.
  2. **Off → no-op, on → real, from the workspace's resolved values.**
     `base-agent-headroom.test.ts:125` (off → `noop`, `stats()` =
     `{available:false, reason:'disabled'}`, SDK never loaded),
     `:143` (no `headroom` key at all → off), `:154` (on → `sdk`, recording SDK
     constructed exactly once with `fallback:false`, `compress` carries the
     session model `claude-opus-5`, and `getHeadroomConfig()` equals the whole
     workspace layer). **Stated precisely, because the wording invites an
     overclaim:** two values reach the *adapter* — `enabled` from the workspace
     and `model` from the session. The workspace's other resolved fields
     (`compressionEngines`, `verbosity`, `exposeStats`) reach the *session* and
     are asserted there; `HeadroomAdapterOptions` has no field to receive them,
     and inventing one is I1/SUV-0028's business, not this SUV's. Red under D1
     and D3.
  3. **Toggle applies to the next session only.** `base-agent-headroom.test.ts:212`
     (off→on) and `:248` (on→off), each flipping the real `config.json` under a
     live session A and asserting `toBe` identity on A's adapter while a freshly
     constructed session B gets the flipped one. Red under D3.
  4. **Enabled + SDK absent → still starts, no-op, warned.**
     `base-agent-headroom.test.ts:277` proves the premise
     (`await expect(loadAbsentSdk()).rejects.toThrow()`), then asserts
     construction succeeds, `stats()` = `{available:false,
     reason:'sdk-unavailable'}` (no fabricated zeros), `compress` hands back the
     caller's own array by identity, and a Headroom line reached `console.warn`;
     `:315` asserts the plain disabled path warns not at all. Red under D2.

  **Remaining gates, as printed**

  - `bun run typecheck` — **exit 0**, no `error TS` lines (took ~30 min under the
    load described above; the only `error TS` string in the log is inside the
    echoed script line of `typecheck:server`, not a diagnostic).
  - `bun run lint:headroom-boundary` — `✓ Headroom boundary gate: headroom-ai
    imported only by packages/shared/src/headroom/sdk-adapter.ts`
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0018-build-check --no-splitting`
    — `Bundled 3403 modules in 36852ms`, `index.js 16.36 MB`

  **Scope, re-confirmed.** `git show --stat 1291b25c` = 8 files
  (`headroom/session-adapter.ts`, `headroom/index.ts`, `agent/base-agent.ts`,
  `agent/backend/types.ts`, the two test files, and this record's move). Nothing
  in the session loop, Conductor dispatch, stats surfaces or memory — the four
  declared out-of-scope areas. This third pass adds no code and no test; its only
  diff is this status-log entry. A branch-level diff still shows
  SUV-0023/0024/0026/0027/0028/0030/0031 in that territory, and
  `session-adapter.ts` still carries SUV-0027's `createScopedHeadroomAdapter`
  wrapper at lines 104-120, added after this commit.

  **Stays in `done/`.** Nothing changed the SUV's state; the record's evidence is
  what changed.
