---
id: SUV-0015
title: Headroom boundary module with no-op fallback
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-27
related: []
blocked-by:
  - SUV-0014-vet-and-pin-headroom-for-adoption.md (the pinned SDK this boundary wraps)
---

# SUV-0015 — Headroom boundary module with no-op fallback

## Goal

Put the pinned Headroom SDK behind a single Vorno-owned TypeScript boundary
module whose no-op implementation keeps Vorno fully functional when Headroom is
absent or disabled.

## Scope

- A `HeadroomAdapter` interface (types in `packages/core`, implementation in
  `packages/shared`) covering the operations the plan will need — compress,
  retrieve original, stats — plus a factory that returns the real SDK-backed
  adapter or a no-op.
- The no-op adapter passes content through untouched and reports stats as
  absent (never fabricated — plan's "measured or absent" rule).
- A guard (lint rule or CI grep) so no file outside the boundary module imports
  the Headroom SDK directly — this is the long-term-support seam that contains
  future SDK upgrades.
- Deliberately out: config resolution (SUV-0016), any call sites in the session
  loop or Conductor (I1), and memory surfaces (I2).

## Acceptance

- [x] A `HeadroomAdapter` interface exists in `packages/core` and the only production import of the Headroom SDK is inside the boundary module in `packages/shared`.
- [x] The factory returns the no-op adapter when the SDK is unavailable or Headroom is disabled, and constructing it never throws — verified by a test that simulates the SDK package being absent.
- [x] The no-op adapter returns input unchanged from compress/retrieve and reports stats as unknown/absent rather than zeros or estimates, with tests asserting both.
- [x] A CI-enforced guard fails the build if any file outside the boundary imports the SDK directly.
- [x] Tests exercise a realistic round-trip through the real adapter against the pinned SDK: compress a representative tool-output payload, retrieve the original, and get byte-identical content back.

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-26` — **implemented on `plan/plan-040`.** All five acceptance items met.

  **What landed**

  - `packages/core/src/types/headroom-adapter.ts` — the `HeadroomAdapter`
    contract. Import-free plain data, same rule as SUV-0016's `headroom.ts`.
    Statistics are wrapped in `HeadroomMeasurement<T>`, whose absent arm carries
    a reason and *no numeric fields*: "measured or absent, never interpolated"
    is enforced by the type, not by convention.
  - `packages/shared/src/headroom/sdk-adapter.ts` — the boundary. The only file
    in the product that may name the SDK. Loads it via dynamic `import()` only,
    so `headroom-ai` is absent from Vorno's static module graph and a build
    without it still starts.
  - `packages/shared/src/headroom/noop-adapter.ts` and `index.ts` — the no-op and
    the `createHeadroomAdapter` factory. The factory is async (the SDK load is a
    dynamic import) and cannot reject: disabled → no-op; absent package → no-op;
    SDK present but missing its export → no-op; constructor throws → no-op.
  - `scripts/check-headroom-boundary.ts` + a dedicated `validate-pr.yml` job +
    root `lint:headroom-boundary`. Supersedes SUV-0014's "imported by nobody"
    test, which asserted zero importers; the successor asserts exactly one, which
    is the permanent invariant. It also fails if the allowlisted boundary file
    stops importing the SDK — otherwise renaming the boundary makes every file
    "not the boundary" and the gate passes on a codebase with no boundary at all.
  - `packages/shared/src/__tests__/headroom-pin.test.ts` — the superseded import
    guard removed as SUV-0014 instructed (deleted, not weakened); pin assertions
    kept.
  - 37 tests across three suites. Shared suite 3523 pass / 0 fail.

  **Four decisions worth carrying forward**

  1. **The SDK's default `fallback: true` fabricates zeros.** An unreachable
     proxy makes `compress()` resolve with `tokensBefore: 0, tokensSaved: 0,
     compressionRatio: 1` for a request that was never compressed — exactly what
     the plan's rule forbids reaching a token surface. The boundary forces
     `fallback: false` and converts the resulting throw into an honest
     pass-through with absent stats. This is the single most load-bearing line in
     the module and it is covered by a test against a genuinely dead endpoint.
  2. **`baseUrl` is always passed explicitly.** The SDK constructor otherwise
     honours `process.env.HEADROOM_BASE_URL`. An ambient env var that silently
     redirects where Vorno's whole context is sent is not a channel this boundary
     should accept; the default is pinned in the module instead.
  3. **Only compress / retrieve / getStats are called** — SUV-0014 F3's
     credential-forwarding chat/messages helpers are never referenced.
  4. **`unknown-handle` vs `service-unavailable`.** The proxy signals "I do not
     hold that hash" as HTTP 404, which the SDK throws rather than returning.
     Read structurally off `error.statusCode` (not `instanceof`, which does not
     survive bundling), so "the service answered and has nothing" stays distinct
     from "the service is down". Found by the round-trip test going red.

  **Reading of acceptance item 5, stated plainly.** SUV-0014 F4 established that
  the TS SDK is a thin HTTP client, not an in-process engine, so a round trip
  needs something answering on `baseUrl`. The suite runs the real factory, real
  dynamic import, real pinned `HeadroomClient` and real wire codec against a
  local server speaking the proxy's CCR protocol: the SDK is real, the
  compression *service* is substituted. It catches an SDK upgrade that renames a
  wire field, moves an endpoint, or changes a result shape; it does not measure
  real compression ratios (that is I0 / SUV-0025). A genuinely live proxy is
  opt-in via `HEADROOM_TEST_BASE_URL` and skipped otherwise — a running service
  is not a CI dependency this repo should take.

  **Deliberately not done** (SUV scope): no config resolution or wiring of
  resolved config into the factory (SUV-0018), no session-loop or Conductor call
  sites (I1), no memory surfaces (I2), no UI (SUV-0017). Nothing in the product
  calls `createHeadroomAdapter` yet.

  **Pre-existing defect found, not fixed here — worth its own change.** Three
  test files install a `globalThis.fetch` mock and never restore it:
  `src/sources/__tests__/oauth-relay.test.ts` (answers every unrecognised URL
  with 404), `.../oauth-callback-url.test.ts`, and
  `.../api-tools-credential-freshness.test.ts`. `bun test` runs the shared suite
  in one process, so the mock leaks into every file that runs afterwards. Nothing
  noticed because no prior test made a real HTTP request; these are the first,
  and they failed in a full run while passing in isolation. This suite defends
  its own preconditions with `Bun.fetch` (native, unreachable by whoever
  reassigned the global) and restores the previous value; the leak itself belongs
  in its own fix, and merits a `LEARNING-NNN` in `vorno-internal`.

- `2026-08-27` — **re-verified by execution and closed.** The implementation
  landed in `bc684751`; this entry records verifying it rather than trusting the
  entry above. Every number below came from a command run in this session.

  **One real gap found and fixed.** Acceptance item 5 claims byte-identical
  round-trip. It did not hold: mutating the boundary's `retrieve` to
  `content.trimEnd()` left `sdk-roundtrip.test.ts` fully green (8 pass / 3 skip /
  0 fail), because `TOOL_OUTPUT` was bare `JSON.stringify` output — it begins
  `{` and ends `}`, so trimming its edges is a no-op and the assertion could not
  fail for the reason it claimed to test. Real tool output is not so tidy: a
  shell capture keeps its trailing newline, and that newline is content. The
  payload is now wrapped in leading and trailing whitespace. Same mutation
  against the new payload: **1 fail** (`retrieves the original content
  byte-for-byte`); restored: **8 pass / 3 skip / 0 fail**. That is the only
  production-affecting behaviour change in this entry — the adapter itself is
  untouched.

  **Red-then-green on the other load-bearing lines**, by mutating the source and
  observing the suite that guards it (each mutation reverted from a `/tmp` copy,
  `git diff --stat` empty afterwards):

  | Mutation | Suite result |
  |---|---|
  | no-op `compress` copies messages + returns `{tokensBefore: 0, …}` | 9 pass / **3 fail** |
  | factory rethrows instead of returning the no-op | 8 pass / **4 fail** |
  | `retrieve` trims content (new payload) | 7 pass / 3 skip / **1 fail** |
  | *(all restored)* | 12 pass / 0 fail · 8 pass / 3 skip / 0 fail |

  **The gate was exercised in both directions live**, not just asserted about:
  adding `packages/shared/src/headroom/__violation-probe.ts` with a real SDK
  import → `exit 1`, naming the file; pointing `BOUNDARY_FILES` at
  `noop-adapter.ts` → `exit 1` on *both* arms (stale allowlist **and** the real
  boundary now unallowlisted). Probe file deleted, script restored.

  **Observed suite results** (not carried over from the entry above):

  - SUV-0015's three suites: **34 tests, 31 pass / 3 skip / 0 fail**. The 3 skips
    are the opt-in `HEADROOM_TEST_BASE_URL` live-proxy block, correctly skipped.
  - `packages/shared` full suite: **3664 tests across 211 files, 3644 pass / 20
    skip / 0 fail** (45.6s).
  - `packages/server-core`: **362 pass / 0 fail**.
  - `bun run typecheck`: clean.
  - `lint:headroom-boundary`, `check-branding.ts`, `lint:i18n:{sorted,parity,coverage}`: pass.

  **Corrections to the `2026-08-26` entry above**, left in place rather than
  edited: it claims "37 tests across three suites" (observed: **34**) and "Shared
  suite 3523 pass" (observed: **3644** — the branch has grown since). Neither
  number reproduces today; the observed ones are above.

  **Two pre-existing defects, deliberately not fixed here** (both out of this
  SUV's scope):

  1. `bun run lint` cannot complete on this branch **or on `main`**:
     `lint:ipc-sends` and `lint:tool-name-checks` invoke
     `scripts/check-raw-sends.sh` and `scripts/check-task-tool-checks.sh`, and
     neither file exists in either ref (`git cat-file -e main:… ` → missing).
     Exit 127, so every lint sub-gate after them is skipped by the `&&` chain.
     They are not among the ten `validate-pr.yml` jobs, so CI is unaffected — but
     `bun run lint` locally is a no-op that looks like a pass.
  2. `packages/server-core/src/handlers/rpc/settings-headroom.test.ts` was
     modified **by another process while this session ran** (mtime moved to
     01:38:12, after this session started, with no edit from here). It is
     SUV-0017 work — a subprocess-based restart-persistence test. Left untouched
     and excluded from this commit, which names its paths explicitly. It passes.

- `2026-08-27` — **independently re-verified a second time; no production code
  changed.** A prior verification pass was rejected for evidence that did not
  reproduce, so this entry re-ran everything from scratch on a clean tree. No
  figure below is carried over from any entry above; each is the tail of a
  command run in this session. All five acceptance items hold, so nothing was
  implemented — the honest deliverable here is the evidence, plus two
  corrections.

  **Acceptance, re-checked by execution**

  | # | Evidence observed now |
  |---|---|
  | 1 | `check-headroom-boundary.ts` → `exit 0`, naming `sdk-adapter.ts` as sole importer. Repo-wide grep: the only value-level SDK reference in product code is `await import('headroom-ai')` at `sdk-adapter.ts:122` (plus a type-only `import type` at :63). `HeadroomAdapter` lives in `packages/core/src/types/headroom-adapter.ts`, re-exported from `types/index.ts`. |
  | 2 | Absent-package path is real, not stubbed: the failure text under mutation reads `Cannot find package 'headroom-ai-not-installed-in-this-repo'` — a genuine module-resolution error. |
  | 3 | Mutation-proven below. |
  | 4 | Both arms exercised live, below. Wired as its own `validate-pr.yml` job (`headroom-boundary`, line 217) and as `lint:headroom-boundary`. |
  | 5 | Payload at `sdk-roundtrip.test.ts:51` carries leading `  \n\t` **and** trailing `\n  \n`, plus non-ASCII, a NUL, and escaped quotes — so a byte assertion can genuinely fail. Mutation-proven below. |

  **Red-then-green, each mutation applied then reverted** (`git status --porcelain`
  and `git diff --stat` both empty after each):

  | Mutation | Observed |
  |---|---|
  | no-op `compress` copies the array + returns `available: true` zeros | adapter-fallback **9 pass / 3 fail** |
  | factory rethrows instead of returning the no-op | adapter-fallback **8 pass / 4 fail** |
  | `retrieve` returns `content.trimEnd()` | sdk-roundtrip **7 pass / 3 skip / 1 fail** — and the one failure is exactly `retrieves the original content byte-for-byte`, killed by the trailing `\n  \n` |
  | gate: add `__violation-probe.ts` importing the SDK | `exit 1`, naming the probe file |
  | gate: point `BOUNDARY_FILES` at `noop-adapter.ts` | `exit 1` on **both** arms — stale entry *and* the real boundary now unallowlisted |
  | *(all reverted)* | three suites **31 pass / 3 skip / 0 fail**; gate `exit 0`; tree clean |

  **Suite results observed now** (CI-equivalent, each run from its own package
  dir — `bunfig.toml` preload is cwd-only, per `packages/shared/CLAUDE.md`):

  - SUV-0015's three suites: **34 tests across 3 files, 31 pass / 3 skip / 0 fail**.
  - `packages/shared`: **3670 tests across 211 files, 3650 pass / 20 skip / 0 fail** (46.4s).
  - `packages/server-core`: **362 pass / 0 fail** across 45 files.
  - `apps/server`: **196 pass / 0 fail** across 18 files.
  - `bun run typecheck`: **exit 0**.
  - `lint:headroom-boundary`, `lint:i18n:{sorted,parity,coverage}`, `check-branding.ts`: all **exit 0**.

  **Two corrections to the entry above**, left in place rather than edited:

  1. It reports the shared suite as "3664 tests … 3644 pass". Observed today:
     **3670 / 3650**. The branch has grown again; the earlier figure is not
     wrong-for-its-day, it is simply stale, and this is now the *second* time
     this number has drifted between sessions. Treat any hard-coded suite total
     in this file as a timestamp, not an invariant.
  2. It says "the 3 skips are the opt-in `HEADROOM_TEST_BASE_URL` live-proxy
     block". True as to origin, but misleading as to size: the junit reporter
     attributes all three skip entries to the *describe* name, and that block
     contains exactly **one** `it`. There is one live-proxy test, not three.
     Anyone reading "3 skipped" as three unexercised assertions is over-counting
     the opt-in coverage threefold.

  **`bun run lint` is still broken, and this run confirmed it independently:**
  **exit 127** at its *first* sub-gate, `lint:ipc-sends` → `bash:
  scripts/check-raw-sends.sh: No such file or directory`. `git cat-file -e
  main:…` confirms both that script and `scripts/check-task-tool-checks.sh` are
  absent from `main` too. Because the chain is `&&`, the 127 means
  `lint:headroom-boundary` **never runs** under `bun run lint` — it passes only
  because CI invokes it as a standalone job. Unrelated to Headroom, broken on
  `main`, out of this SUV's scope; still worth its own change.

  **Root `bun test` is not a CI gate and should not be read as one.** Run from
  the repo root it reports failures (**40 fail** on one run, **63** on another —
  the count is not stable between runs). Cause is documented in
  `packages/shared/CLAUDE.md`: bun reads `bunfig.toml` from cwd only, so the
  hermetic `CRAFT_CONFIG_DIR` preload does not apply at root and the
  `config-dir-guard` tests red by design; the instability on top of that is
  consistent with the cross-file `globalThis.fetch` leak recorded in the
  `2026-08-26` entry. **Zero of those failures are in Headroom files** (grep of
  the fail lines: 0 matches). CI runs `cd packages/shared && bun test`, which is
  green. Nothing here was fixed — it is recorded so the next reader does not
  mistake a cwd artifact for a regression.

  **Nothing outside this file changed.** No production or test source was
  modified; the only diff in this commit is this status-log entry.
