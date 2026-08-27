---
id: SUV-0018
title: Resolved config drives the Headroom boundary
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-26
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
  - `SUV-0015` is still filed under `planned/` despite its code being on this
    branch. Correcting another SUV's folder is not this SUV's diff.
