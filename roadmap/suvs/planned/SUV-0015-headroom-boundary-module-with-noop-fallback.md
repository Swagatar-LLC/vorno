---
id: SUV-0015
title: Headroom boundary module with no-op fallback
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-26
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
