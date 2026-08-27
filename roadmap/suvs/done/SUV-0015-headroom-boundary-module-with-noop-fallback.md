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
